#!/usr/bin/env python3
"""Self-cleaning black-box benchmark for LaoJi meeting-audio uploads."""

from __future__ import annotations

import argparse
import http.client
import json
import math
import secrets
import ssl
import statistics
import tempfile
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener


class BenchmarkFailure(RuntimeError):
    pass


def validate_base_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise argparse.ArgumentTypeError("base URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise argparse.ArgumentTypeError("base URL must not contain credentials, query, or fragment")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def parse_minutes(value: str) -> list[float]:
    try:
        values = [float(item.strip()) for item in value.split(",") if item.strip()]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("minutes must be comma-separated numbers") from exc
    if not values or any(not math.isfinite(item) or item <= 0 or item > 180 for item in values):
        raise argparse.ArgumentTypeError("each duration must be greater than 0 and at most 180 minutes")
    return values


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))
    return round(ordered[index], 1)


class JsonClient:
    def __init__(self, timeout_seconds: float) -> None:
        self.timeout_seconds = timeout_seconds
        self.opener = build_opener(ProxyHandler({}))

    def request(
        self,
        method: str,
        url: str,
        *,
        token: str | None = None,
        body: dict[str, Any] | None = None,
    ) -> tuple[int, Any, float]:
        headers = {"Accept": "application/json", "User-Agent": "LaoJi-audio-benchmark/1.0"}
        payload = None
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=payload, headers=headers, method=method)
        started = time.perf_counter()
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                status = response.status
                raw = response.read()
        except HTTPError as error:
            status = error.code
            raw = error.read()
        except (URLError, TimeoutError, OSError) as error:
            raise BenchmarkFailure(f"transport failure: {type(error).__name__}") from error
        elapsed_ms = (time.perf_counter() - started) * 1000
        if not raw:
            data: Any = None
        else:
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                data = {"non_json_response": True, "size_bytes": len(raw)}
        return status, data, round(elapsed_ms, 1)


def write_silence_wav(path: Path, minutes: float, sample_rate: int = 16_000) -> int:
    frame_count = round(minutes * 60 * sample_rate)
    chunk_frames = sample_rate * 10
    silence = b"\0\0" * chunk_frames
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        remaining = frame_count
        while remaining:
            count = min(remaining, chunk_frames)
            output.writeframesraw(silence[: count * 2])
            remaining -= count
    return path.stat().st_size


def upload_multipart(
    base_url: str,
    path: str,
    token: str,
    audio_path: Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    parsed = urlsplit(base_url)
    connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    kwargs: dict[str, Any] = {"timeout": timeout_seconds}
    if parsed.scheme == "https":
        kwargs["context"] = ssl.create_default_context()
    connection = connection_type(parsed.hostname, parsed.port, **kwargs)
    boundary = f"----LaoJiBenchmark{uuid.uuid4().hex}"
    prefix = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{audio_path.name}"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode("ascii")
    suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
    file_size = audio_path.stat().st_size
    full_path = f"{parsed.path.rstrip('/')}{path}"
    started = time.perf_counter()
    try:
        connection.putrequest("POST", full_path)
        connection.putheader("Accept", "application/json")
        connection.putheader("Authorization", f"Bearer {token}")
        connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        connection.putheader("Content-Length", str(len(prefix) + file_size + len(suffix)))
        connection.putheader("User-Agent", "LaoJi-audio-benchmark/1.0")
        connection.endheaders()
        connection.send(prefix)
        with audio_path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                connection.send(chunk)
        connection.send(suffix)
        sent_at = time.perf_counter()
        response = connection.getresponse()
        raw = response.read()
        finished = time.perf_counter()
    except (OSError, TimeoutError, http.client.HTTPException) as error:
        raise BenchmarkFailure(f"upload transport failure: {type(error).__name__}") from error
    finally:
        connection.close()
    try:
        data = json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        data = {"non_json_response": True, "size_bytes": len(raw)}
    elapsed = finished - started
    return {
        "status": response.status,
        "size_bytes": file_size,
        "elapsed_ms": round(elapsed * 1000, 1),
        "response_wait_ms": round((finished - sent_at) * 1000, 1),
        "throughput_mib_s": round(file_size / 1024 / 1024 / elapsed, 2),
        "response": data,
    }


class HealthProbe:
    def __init__(self, client: JsonClient, url: str, interval_seconds: float = 0.1) -> None:
        self.client = client
        self.url = url
        self.interval_seconds = interval_seconds
        self.stop_event = threading.Event()
        self.samples: list[tuple[int, float]] = []
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                status, _, latency = self.client.request("GET", self.url)
                self.samples.append((status, latency))
            except BenchmarkFailure:
                self.samples.append((0, self.client.timeout_seconds * 1000))
            self.stop_event.wait(self.interval_seconds)

    def __enter__(self) -> "HealthProbe":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.stop_event.set()
        self.thread.join(timeout=self.client.timeout_seconds + 1)

    def report(self) -> dict[str, Any]:
        latencies = [latency for _, latency in self.samples]
        return {
            "samples": len(self.samples),
            "failures": sum(1 for status, _ in self.samples if status != 200),
            "median_ms": round(statistics.median(latencies), 1) if latencies else None,
            "p95_ms": percentile(latencies, 0.95),
            "max_ms": round(max(latencies), 1) if latencies else None,
        }


def require_status(name: str, result: tuple[int, Any, float], expected: set[int]) -> Any:
    status, data, _ = result
    if status not in expected:
        raise BenchmarkFailure(f"{name} returned HTTP {status}")
    return data


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    client = JsonClient(args.timeout)
    run_id = uuid.uuid4().hex
    account = f"laoji.audio.benchmark.{run_id}@example.com"
    password = f"Aa1!{secrets.token_urlsafe(18)}"
    token: str | None = None
    meeting_ids: list[str] = []
    cleanup: dict[str, Any] = {"attempted": False, "deleted": False}
    report: dict[str, Any] = {
        "schema_version": 1,
        "durations_minutes": args.minutes,
        "sample_rate_hz": 16_000,
        "channels": 1,
        "sample_width_bytes": 2,
        "uploads": [],
    }
    with tempfile.TemporaryDirectory(prefix="laoji-audio-benchmark-") as directory:
        try:
            register = client.request(
                "POST",
                f"{args.auth_base}/api/auth/register",
                body={"account": account, "password": password, "nickname": "录音上传基准"},
            )
            data = require_status("register", register, {201})
            if not isinstance(data, dict) or not isinstance(data.get("access_token"), str):
                raise BenchmarkFailure("register returned no access token")
            token = data["access_token"]

            for index, minutes in enumerate(args.minutes, start=1):
                meeting = client.request(
                    "POST",
                    f"{args.meeting_base}/api/laoji/meetings",
                    token=token,
                    body={
                        "title": f"上传基准 {minutes:g} 分钟",
                        "description": "自动清理的性能基准数据",
                        "participants": [],
                        "mode": "realtime",
                        "client_request_id": f"audio-benchmark:{run_id}:{index}",
                    },
                )
                meeting_data = require_status("create meeting", meeting, {201})
                meeting_id = meeting_data.get("id") if isinstance(meeting_data, dict) else None
                if not isinstance(meeting_id, str) or not meeting_id:
                    raise BenchmarkFailure("create meeting returned no id")
                meeting_ids.append(meeting_id)

                audio_path = Path(directory) / f"benchmark-{minutes:g}m.wav"
                write_silence_wav(audio_path, minutes)
                with HealthProbe(client, f"{args.meeting_base}/health") as probe:
                    upload = upload_multipart(
                        args.meeting_base,
                        f"/api/laoji/meetings/{quote(meeting_id, safe='')}/audio",
                        token,
                        audio_path,
                        args.timeout,
                    )
                if upload["status"] != 200:
                    raise BenchmarkFailure(f"upload returned HTTP {upload['status']}")
                audio_info = client.request(
                    "GET",
                    f"{args.meeting_base}/api/laoji/meetings/{quote(meeting_id, safe='')}/audio",
                    token=token,
                )
                info_data = require_status("audio info", audio_info, {200})
                upload.pop("response", None)
                upload.update(
                    {
                        "minutes": minutes,
                        "health_during_upload": probe.report(),
                        "duration_sec_reported": info_data.get("duration_sec") if isinstance(info_data, dict) else None,
                    }
                )
                report["uploads"].append(upload)
        finally:
            if token:
                cleanup["attempted"] = True
                delete = client.request(
                    "DELETE",
                    f"{args.auth_base}/api/auth/me",
                    token=token,
                    body={"current_password": password, "confirmation": "删除账号"},
                )
                cleanup["status"] = delete[0]
                cleanup["latency_ms"] = delete[2]
                cleanup["deleted"] = bool(
                    delete[0] == 200 and isinstance(delete[1], dict) and delete[1].get("deleted") is True
                )
                cleanup["meetings_deleted"] = (
                    delete[1].get("meetings_deleted") if isinstance(delete[1], dict) else None
                )
    report["cleanup"] = cleanup
    report["passed"] = len(report["uploads"]) == len(args.minutes) and cleanup["deleted"]
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auth-base", required=True, type=validate_base_url)
    parser.add_argument("--meeting-base", required=True, type=validate_base_url)
    parser.add_argument("--minutes", default=[1.0, 10.0, 30.0], type=parse_minutes)
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--confirm-live-mutations", action="store_true")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.confirm_live_mutations:
        parser.error("--confirm-live-mutations is required because this creates and deletes live test data")
    try:
        report = run_benchmark(args)
    except BenchmarkFailure as error:
        print(json.dumps({"passed": False, "error": str(error)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
