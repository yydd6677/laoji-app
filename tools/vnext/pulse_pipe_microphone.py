#!/usr/bin/env python3
"""Stable host microphone source for repeated Android Emulator captures.

PipeWire's PulseAudio compatibility layer suspends a null-sink monitor between
short AudioRecord sessions.  Reopening a playback stream for each replay can
therefore yield a valid Android capture containing only digital silence.  This
helper keeps one small-fragment pipe source, one PCM writer and one discard
reader alive for the whole replay.  Individual WAV files are inserted into the
otherwise silent stream without replacing the source seen by QEMU.

This is evidence tooling only.  It is not imported by LaoJi product runtime.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
import queue
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time

try:  # Pulse bridge is Linux-only; keep gRPC replay importable on Windows.
    import fcntl
except ImportError:  # pragma: no cover - exercised by Windows development hosts
    fcntl = None  # type: ignore[assignment]


@dataclass
class _Playback:
    pcm: bytes
    completed: threading.Event = field(default_factory=threading.Event)
    error: BaseException | None = None


class PulsePipeMicrophone:
    """Own a low-latency Pulse pipe source and inject WAVs into it serially."""

    def __init__(
        self,
        source_name: str,
        *,
        sample_rate: int = 48_000,
        fragment_ms: int = 10,
    ) -> None:
        normalized = source_name.strip()
        if not normalized or any(character.isspace() for character in normalized):
            raise ValueError("source_name must be a non-empty PulseAudio identifier")
        if sample_rate != 48_000:
            raise ValueError("only the emulator-native 48 kHz rate is supported")
        if not 5 <= fragment_ms <= 50:
            raise ValueError("fragment_ms must be between 5 and 50")
        self.source_name = normalized
        self.sample_rate = sample_rate
        self.fragment_ms = fragment_ms
        self.frames_per_fragment = sample_rate * fragment_ms // 1_000
        self.fragment_bytes = self.frames_per_fragment * 2
        self._temporary: tempfile.TemporaryDirectory[str] | None = None
        self._fifo: Path | None = None
        self._module_id: str | None = None
        self._sink_module_id: str | None = None
        self._loopback_module_id: str | None = None
        self._keepalive: subprocess.Popen[bytes] | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._jobs: queue.Queue[_Playback] = queue.Queue(maxsize=1)
        self._fatal_error: BaseException | None = None
        self._pcm_cache: dict[tuple[str, int, int], bytes] = {}
        self._moved_source_outputs: list[tuple[str, str]] = []

    def __enter__(self) -> "PulsePipeMicrophone":
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()

    @property
    def module_id(self) -> str | None:
        return self._module_id

    def start(self) -> None:
        if self._module_id is not None:
            return
        for executable in ("pactl", "parec", "ffmpeg"):
            if shutil.which(executable) is None:
                raise RuntimeError(f"{executable} is required for Pulse pipe replay")
        existing = subprocess.run(
            ["pactl", "list", "short", "sources"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        if any(
            len(line.split("\t")) >= 2 and line.split("\t")[1] == self.source_name
            for line in existing.splitlines()
        ):
            raise RuntimeError(f"Pulse source already exists: {self.source_name}")

        self._temporary = tempfile.TemporaryDirectory(prefix="laoji-pipe-mic-")
        self._fifo = Path(self._temporary.name) / "microphone.pcm"
        os.mkfifo(self._fifo, mode=0o600)
        loaded = subprocess.run(
            [
                "pactl",
                "load-module",
                "module-pipe-source",
                f"source_name={self.source_name}",
                f"file={self._fifo}",
                "format=s16le",
                f"rate={self.sample_rate}",
                "channels=1",
                f"fragment_size={self.fragment_bytes}",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self._module_id = loaded.stdout.strip()
        if not self._module_id:
            self.close()
            raise RuntimeError("pactl did not return a module id")

        self._thread = threading.Thread(
            target=self._pump,
            name="laoji-pulse-pipe-microphone",
            daemon=True,
        )
        self._thread.start()
        # Opening the writer before the reader mirrors the working
        # module-pipe-source handshake: the writer blocks until Pulse starts
        # the source instead of observing an early EOF.
        time.sleep(0.05)
        self._keepalive = subprocess.Popen(
            [
                "parec",
                f"--device={self.source_name}",
                "--format=s16le",
                f"--rate={self.sample_rate}",
                "--channels=1",
                f"--latency-msec={self.fragment_ms}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if not self._ready.wait(5):
            self.close()
            raise RuntimeError("Pulse pipe microphone writer did not become ready")
        self._raise_if_failed()
        time.sleep(0.1)
        if self._keepalive.poll() is not None:
            self.close()
            raise RuntimeError("Pulse pipe microphone keepalive exited during startup")

    def _raise_if_failed(self) -> None:
        if self._fatal_error is not None:
            raise RuntimeError("Pulse pipe microphone failed") from self._fatal_error

    def _normalized_pcm(self, wav_path: Path) -> bytes:
        resolved = wav_path.expanduser().resolve()
        stat = resolved.stat()
        key = (str(resolved), stat.st_mtime_ns, stat.st_size)
        cached = self._pcm_cache.get(key)
        if cached is not None:
            return cached
        result = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(resolved),
                "-ac",
                "1",
                "-ar",
                str(self.sample_rate),
                "-f",
                "s16le",
                "pipe:1",
            ],
            check=True,
            capture_output=True,
        )
        pcm = result.stdout
        if not pcm or len(pcm) % 2:
            raise RuntimeError("normalized microphone PCM is empty or unaligned")
        self._pcm_cache.clear()
        self._pcm_cache[key] = pcm
        return pcm

    def play(self, wav_path: Path, *, timeout: float | None = None) -> None:
        if self._module_id is None:
            raise RuntimeError("Pulse pipe microphone has not been started")
        self._raise_if_failed()
        if self._keepalive is None or self._keepalive.poll() is not None:
            raise RuntimeError("Pulse pipe microphone keepalive is not running")
        pcm = self._normalized_pcm(wav_path)
        self._play_pcm(pcm, timeout=timeout)

    def _play_pcm(self, pcm: bytes, *, timeout: float | None = None) -> None:
        if not pcm or len(pcm) % 2:
            raise ValueError("playback PCM must contain aligned s16le samples")
        playback = _Playback(pcm=pcm)
        self._jobs.put(playback, timeout=2)
        duration = len(pcm) / (self.sample_rate * 2)
        wait_timeout = timeout if timeout is not None else max(10, duration + 5)
        if not playback.completed.wait(wait_timeout):
            raise TimeoutError("Pulse pipe microphone playback timed out")
        if playback.error is not None:
            raise RuntimeError("Pulse pipe microphone playback failed") from playback.error
        self._raise_if_failed()

    def prime_route(
        self,
        *,
        signal_seconds: float = 0.35,
        settle_seconds: float = 0.75,
    ) -> None:
        """Drive a bounded non-speech signal through an idle bridge, then drain it.

        QEMU keeps one Pulse source-output open even when Android has no active
        ``AudioRecord``.  Immediately after that stream is moved to a new monitor,
        its first Android capture can still consume only the old silent buffer.
        A short alternating signal makes every bridge stage RUNNING before any
        measured product capture.  The following silence interval is longer than
        the configured loopback latency, so the priming signal cannot become part
        of the first measured utterance.
        """
        if not 0.1 <= signal_seconds <= 2.0:
            raise ValueError("signal_seconds must be between 0.1 and 2.0")
        if not 0.2 <= settle_seconds <= 3.0:
            raise ValueError("settle_seconds must be between 0.2 and 3.0")
        frame_count = round(self.sample_rate * signal_seconds)
        # A low-amplitude alternating signal is intentionally not speech and
        # avoids a dependency on waveform generators in the evidence harness.
        pattern = struct.pack("<hh", 4_096, -4_096)
        pcm = (pattern * ((frame_count + 1) // 2))[: frame_count * 2]
        self._play_pcm(pcm, timeout=signal_seconds + 5)
        time.sleep(settle_seconds)

    def move_source_outputs_for_pid(
        self,
        process_pid: int,
        *,
        target_source_name: str | None = None,
    ) -> int:
        """Move existing Pulse capture streams for one host process to this source."""
        if self._module_id is None:
            raise RuntimeError("Pulse pipe microphone has not been started")
        if process_pid <= 0:
            raise ValueError("process_pid must be positive")
        sources = subprocess.run(
            ["pactl", "list", "short", "sources"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        source_names = {
            columns[0]: columns[1]
            for line in sources.splitlines()
            if len(columns := line.split("\t")) >= 2
        }
        details = subprocess.run(
            ["pactl", "list", "source-outputs"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        moved = 0
        for block in re.split(r"(?=^Source Output #)", details, flags=re.MULTILINE):
            output_match = re.search(r"^Source Output #(\d+)$", block, flags=re.MULTILINE)
            pid_match = re.search(
                r'^\s*application\.process\.id = "(\d+)"$',
                block,
                flags=re.MULTILINE,
            )
            source_match = re.search(r"^\s*Source: (\d+)$", block, flags=re.MULTILINE)
            if output_match is None or pid_match is None or source_match is None:
                continue
            if int(pid_match.group(1)) != process_pid:
                continue
            original_source = source_names.get(source_match.group(1))
            if original_source is None:
                raise RuntimeError("Pulse source output has an unknown original source")
            output_id = output_match.group(1)
            subprocess.run(
                [
                    "pactl",
                    "move-source-output",
                    output_id,
                    target_source_name or self.source_name,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self._moved_source_outputs.append((output_id, original_source))
            moved += 1
        if moved == 0:
            raise RuntimeError(f"no Pulse source output belongs to process {process_pid}")
        return moved

    def bridge_to_monitor_sink(self, sink_name: str, *, process_pid: int) -> int:
        """Feed a named sink monitor and bind one QEMU capture stream to it."""
        if self._module_id is None:
            raise RuntimeError("Pulse pipe microphone has not been started")
        normalized = sink_name.strip()
        if not normalized or any(character.isspace() for character in normalized):
            raise ValueError("sink_name must be a non-empty PulseAudio identifier")
        existing = subprocess.run(
            ["pactl", "list", "short", "sinks"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        if any(
            len(line.split("\t")) >= 2 and line.split("\t")[1] == normalized
            for line in existing.splitlines()
        ):
            raise RuntimeError(f"Pulse sink already exists: {normalized}")
        sink = subprocess.run(
            [
                "pactl",
                "load-module",
                "module-null-sink",
                f"sink_name={normalized}",
                "format=s16le",
                f"rate={self.sample_rate}",
                "channels=1",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if not sink:
            raise RuntimeError("pactl did not return a null-sink module id")
        self._sink_module_id = sink
        loopback = subprocess.run(
            [
                "pactl",
                "load-module",
                "module-loopback",
                f"source={self.source_name}",
                f"sink={normalized}",
                f"latency_msec={self.fragment_ms}",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if not loopback:
            raise RuntimeError("pactl did not return a loopback module id")
        self._loopback_module_id = loopback
        time.sleep(0.15)
        moved = self.move_source_outputs_for_pid(
            process_pid,
            target_source_name=f"{normalized}.monitor",
        )
        self._wait_for_source_output_route(
            process_pid=process_pid,
            target_source_name=f"{normalized}.monitor",
            timeout=5,
        )
        return moved

    def _wait_for_source_output_route(
        self,
        *,
        process_pid: int,
        target_source_name: str,
        timeout: float,
    ) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            sources = subprocess.run(
                ["pactl", "list", "short", "sources"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            source_names = {
                columns[0]: columns[1]
                for line in sources.splitlines()
                if len(columns := line.split("\t")) >= 2
            }
            details = subprocess.run(
                ["pactl", "list", "source-outputs"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            matches = 0
            routed = 0
            for block in re.split(r"(?=^Source Output #)", details, flags=re.MULTILINE):
                pid_match = re.search(
                    r'^\s*application\.process\.id = "(\d+)"$',
                    block,
                    flags=re.MULTILINE,
                )
                source_match = re.search(r"^\s*Source: (\d+)$", block, flags=re.MULTILINE)
                if pid_match is None or source_match is None:
                    continue
                if int(pid_match.group(1)) != process_pid:
                    continue
                matches += 1
                if source_names.get(source_match.group(1)) == target_source_name:
                    routed += 1
            if matches > 0 and routed == matches:
                return
            time.sleep(0.05)
        raise RuntimeError(
            f"Pulse source outputs for process {process_pid} did not stay on "
            f"{target_source_name}",
        )

    def _restore_source_outputs(self) -> None:
        for output_id, source_name in reversed(self._moved_source_outputs):
            subprocess.run(
                ["pactl", "move-source-output", output_id, source_name],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        self._moved_source_outputs.clear()

    def _pump(self) -> None:
        assert self._fifo is not None
        pump_bytes = self.fragment_bytes * 4
        pump_seconds = self.fragment_ms * 4 / 1_000
        silence = bytes(pump_bytes)
        active: _Playback | None = None
        offset = 0
        deadline = time.monotonic()
        try:
            with self._fifo.open("wb", buffering=0) as sink:
                # module-pipe-source consumes a FIFO ahead of the actual audio
                # clock, so blocking writes alone cannot pace a replay. Drive
                # four fragments (40 ms by default) per deadline: this keeps
                # real-time duration while reducing Python scheduling wakeups
                # by 4x compared with the original 10 ms loop.
                requested_pipe_bytes = max(4_096, self.fragment_bytes * 4)
                try:
                    if fcntl is not None:
                        fcntl.fcntl(sink.fileno(), fcntl.F_SETPIPE_SZ, requested_pipe_bytes)
                except OSError:
                    # Some kernels disallow resizing. The default pipe remains
                    # safe; it only increases the bounded host-side lead.
                    pass
                self._ready.set()
                while not self._stop.is_set():
                    if active is None:
                        try:
                            active = self._jobs.get_nowait()
                            offset = 0
                        except queue.Empty:
                            pass
                    if active is None:
                        chunk = silence
                    else:
                        chunk = active.pcm[offset:offset + pump_bytes]
                        if len(chunk) < pump_bytes:
                            chunk += bytes(pump_bytes - len(chunk))
                        offset += min(pump_bytes, len(active.pcm) - offset)
                    sink.write(chunk)
                    if active is not None and offset >= len(active.pcm):
                        active.completed.set()
                        active = None
                        offset = 0
                    deadline += pump_seconds
                    remaining = deadline - time.monotonic()
                    if remaining > 0:
                        time.sleep(remaining)
                    elif remaining < -0.5:
                        # Do not accelerate indefinitely after a host stall;
                        # resume from the current audio-clock position.
                        deadline = time.monotonic()
        except BaseException as error:
            self._fatal_error = error
            if active is not None:
                active.error = error
                active.completed.set()
            while True:
                try:
                    pending = self._jobs.get_nowait()
                except queue.Empty:
                    break
                pending.error = error
                pending.completed.set()
            self._ready.set()

    def close(self) -> None:
        self._restore_source_outputs()
        for module_id in (self._loopback_module_id, self._sink_module_id):
            if module_id is not None:
                subprocess.run(
                    ["pactl", "unload-module", module_id],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        self._loopback_module_id = None
        self._sink_module_id = None
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self._keepalive is not None and self._keepalive.poll() is None:
            self._keepalive.terminate()
            try:
                self._keepalive.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._keepalive.kill()
                self._keepalive.wait(timeout=2)
        if self._module_id is not None:
            subprocess.run(
                ["pactl", "unload-module", self._module_id],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        if self._temporary is not None:
            self._temporary.cleanup()
        self._module_id = None
        self._keepalive = None
        self._thread = None
        self._temporary = None
        self._fifo = None
