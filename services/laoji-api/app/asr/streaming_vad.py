"""Streaming VAD and optional speaker-boundary detection for Qwen3-ASR."""

import threading
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch

# ============== 配置 ==============

@dataclass
class StreamingChangeDetectorConfig:
    embedding_interval_ms: float = 100.0
    embedding_min_for_detection: int = 5

    change_distance_threshold: float = 0.10
    change_confirm_count: int = 1
    min_change_interval_ms: float = 800.0

    use_dynamic_threshold: bool = True
    dynamic_factor: float = 0.3

    use_sliding_window: bool = True
    sliding_window_size: int = 4

    detect_jump_only: bool = True
    jump_threshold: float = 0.08
    jump_confirm_count: int = 1

    min_segment_duration_ms: float = 2000.0
    warmup_duration_ms: float = 1500.0

    offline_changepoint: bool = True
    cp_min_segment_ms: float = 800.0
    cp_penalty: float = 0.2

    def __post_init__(self):
        assert self.change_confirm_count >= 1


CHANGE_DETECTOR_CONFIG = StreamingChangeDetectorConfig()


VAD_WINDOW_SIZE = 512
VAD_THRESHOLD = 0.30

MIN_SPEECH_DURATION_MS = 800
MIN_SILENCE_DURATION_MS = 800

MIN_SPEECH_ENERGY_THRESHOLD = 0.005

SEGMENT_OVERLAP_TAIL_MS = 200
# ============== 数据结构 ==============
@dataclass
class SpeechSegment:
    audio_data: np.ndarray
    start_ms: int
    end_ms: int
    segment_reason: str = "unknown"
    overlap_tail: Optional[np.ndarray] = None
    speaker_id: Optional[str] = None
    speaker_label: Optional[str] = None
    speaker_name: Optional[str] = None
    speaker_uncertain: bool = False
    speaker_uncertain_reason: Optional[str] = None
    speaker_sims: Optional[Dict[str, float]] = None
    embedding: Optional[np.ndarray] = None
    _pending: bool = True


# ============== 流式 VAD ==============

class StreamingVAD:
    def __init__(self, vad_model, sample_rate: int = 16000):
        self.vad_model = vad_model
        self.sample_rate = sample_rate
        self.window_samples = VAD_WINDOW_SIZE
        self.pre_roll_samples = 0
        self.initial_pre_roll_samples = 0
        self.reset()
        self.min_speech_samples = int(MIN_SPEECH_DURATION_MS * sample_rate / 1000)
        self.min_silence_samples = int(MIN_SILENCE_DURATION_MS * sample_rate / 1000)
        self.min_energy_threshold = MIN_SPEECH_ENERGY_THRESHOLD
        self.max_speech_samples: Optional[int] = None

        self._buffer: np.ndarray = np.array([], dtype=np.float32)
        self._total_samples_processed = 0

        self._embedding_buffer: List[np.ndarray] = []
        self._embedding_timestamps_ms: List[int] = []
        self._last_embedding_extract_ms = 0
        self._embedding_extractor = None
        # 变点检测：0.15s 跳步 + 0.8s 重叠窗（5s 延迟预算下提升 embedding 可靠性，压测 F1 0.37→0.91）
        self._embedding_extraction_interval_samples = int(150 * sample_rate / 1000)
        self._emb_window_samples = int(800 * sample_rate / 1000)
        self._pending_audio_lock = threading.Lock()
        self._embedding_lock = threading.Lock()
        self._last_change_detected_ms = -999999
        self._pending_audio_for_embedding: List[np.ndarray] = []
        self._prev_segment_tail: Optional[np.ndarray] = None

        self._speaker_change_cooldown_until_ms: int = 0
        self._speaker_change_cooldown_ms: int = 1500
        self._last_confirmed_speaker_label: Optional[str] = None

    def reset(self):
        self.state = "idle"
        self.speech_buffer: List[np.ndarray] = []
        self.speech_start_sample = 0
        self.silence_samples = 0
        self._pre_roll_buffer: List[np.ndarray] = []
        self._buffer = np.array([], dtype=np.float32)
        self._total_samples_processed = 0
        self._embedding_buffer = []
        self._embedding_timestamps_ms = []
        self._last_embedding_extract_ms = 0
        self._last_change_detected_ms = -999999
        self._pending_audio_for_embedding = []
        self._prev_segment_tail = None
        self._seen_speech = False
        self._current_pre_roll_samples = 0
        self._speaker_change_cooldown_until_ms = 0
        self._last_confirmed_speaker_label = None

    def feed(self, audio_chunk: np.ndarray) -> Optional[SpeechSegment]:
        self._buffer = np.concatenate([self._buffer, audio_chunk])

        while len(self._buffer) >= VAD_WINDOW_SIZE:
            chunk = self._buffer[:VAD_WINDOW_SIZE]
            self._buffer = self._buffer[VAD_WINDOW_SIZE:]

            is_speech = self._detect_speech(chunk)

            if is_speech and self._embedding_extractor is not None:
                self._pending_audio_for_embedding.append(chunk.copy())

            result = self._update_state(is_speech, chunk)
            self._total_samples_processed += VAD_WINDOW_SIZE
            if result:
                return result

        return None

    def _detect_speech(self, chunk: np.ndarray) -> bool:
        energy = np.mean(chunk ** 2)
        if energy < self.min_energy_threshold:
            return False

        if self.vad_model is None:
            return True

        try:
            tensor = torch.from_numpy(chunk).float().unsqueeze(0)
            model_device = next(self.vad_model.parameters(), torch.zeros(0, device='cpu')).device
            tensor = tensor.to(model_device)
            prob = self.vad_model(tensor, self.sample_rate).item()
            return prob > VAD_THRESHOLD
        except Exception:
            return False

    def set_embedding_extractor(self, extractor):
        self._embedding_extractor = extractor

    def set_max_speech_duration(self, max_duration_ms: Optional[float]):
        if max_duration_ms is None or max_duration_ms <= 0:
            self.max_speech_samples = None
        else:
            self.max_speech_samples = int(max_duration_ms * self.sample_rate / 1000)

    def set_min_energy_threshold(self, threshold: float):
        self.min_energy_threshold = max(0.0, float(threshold))

    def set_min_silence_duration(self, duration_ms: float):
        duration_samples = int(max(0.0, float(duration_ms)) * self.sample_rate / 1000)
        self.min_silence_samples = max(self.window_samples, duration_samples)

    def set_pre_roll_duration(
        self,
        duration_ms: float,
        initial_duration_ms: Optional[float] = None,
    ):
        self.pre_roll_samples = max(0, int(float(duration_ms) * self.sample_rate / 1000))
        initial_ms = duration_ms if initial_duration_ms is None else initial_duration_ms
        self.initial_pre_roll_samples = max(0, int(float(initial_ms) * self.sample_rate / 1000))
        self._trim_pre_roll_buffer(self._active_pre_roll_samples())

    def _active_pre_roll_samples(self) -> int:
        return self.pre_roll_samples if self._seen_speech else self.initial_pre_roll_samples

    def _append_pre_roll(self, chunk: np.ndarray):
        active_samples = self._active_pre_roll_samples()
        if active_samples <= 0:
            return
        self._pre_roll_buffer.append(chunk.copy())
        self._trim_pre_roll_buffer(active_samples)

    def _trim_pre_roll_buffer(self, limit_samples: Optional[int] = None):
        limit = self.pre_roll_samples if limit_samples is None else max(0, limit_samples)
        remaining = sum(len(chunk) for chunk in self._pre_roll_buffer)
        while self._pre_roll_buffer and remaining > limit:
            overflow = remaining - limit
            first = self._pre_roll_buffer[0]
            if overflow >= len(first):
                remaining -= len(first)
                self._pre_roll_buffer.pop(0)
            else:
                self._pre_roll_buffer[0] = first[overflow:].copy()
                remaining -= overflow

    def _retain_audio_tail_as_pre_roll(self, audio_data: np.ndarray):
        if self.pre_roll_samples <= 0:
            self._pre_roll_buffer = []
            return
        tail = audio_data[-self.pre_roll_samples:]
        self._pre_roll_buffer = [tail.copy()] if len(tail) else []

    def extract_pending_embeddings(self) -> List[np.ndarray]:
        if self._embedding_extractor is None:
            return []

        with self._pending_audio_lock:
            if not self._pending_audio_for_embedding:
                return []

            audio = np.concatenate(self._pending_audio_for_embedding)
            self._pending_audio_for_embedding = []

            extracted = []
            hop = self._embedding_extraction_interval_samples   # 0.15s 跳步
            win = self._emb_window_samples                       # 0.8s 重叠窗
            while len(audio) >= win:
                chunk = audio[:win]
                audio = audio[hop:]                              # 只前进一个 hop，保留重叠

                try:
                    emb = self._embedding_extractor.extract(chunk)
                    if emb is not None and len(emb) > 0:
                        emb_norm = np.linalg.norm(emb)
                        if emb_norm < 1e-6:
                            continue
                        ts = int(self._total_samples_processed * 1000 / self.sample_rate)
                        with self._embedding_lock:
                            self._embedding_buffer.append(emb)
                            self._embedding_timestamps_ms.append(ts)
                        extracted.append(emb)
                        self._last_embedding_extract_ms = ts
                except Exception:
                    pass

            if len(audio) > 0:
                self._pending_audio_for_embedding.insert(0, audio)

            return extracted

    def _find_changepoint_offline(
        self,
        timestamps_ms: np.ndarray,
        distances: np.ndarray,
        start_ms: int,
        end_ms: int,
    ) -> Tuple[int, int]:
        cfg = CHANGE_DETECTOR_CONFIG
        if not cfg.offline_changepoint or len(distances) < 4:
            return start_ms, end_ms

        n = len(distances)

        def cost(seg: np.ndarray) -> float:
            if len(seg) < 2:
                return 0.0
            return float(np.var(seg)) * len(seg)

        def find_single_cp(seq: np.ndarray, start: int, stop: int) -> Tuple[float, int]:
            best_gain = 0.0
            best_cp = -1
            total_cost = cost(seq[start:stop])
            if total_cost <= 0:
                return 0.0, -1
            for t in range(start + 2, stop - 2):
                left = seq[start:t]
                right = seq[t:stop]
                gain = total_cost - cost(left) - cost(right) - cfg.cp_penalty
                if gain > best_gain:
                    best_gain = gain
                    best_cp = t
            return best_gain, best_cp

        cps = []
        stack = [(0, n)]
        while stack:
            start_, stop_ = stack.pop()
            gain, cp = find_single_cp(distances, start_, stop_)
            if cp < 0:
                continue
            cps.append(cp)
            stack.append((start_, cp))
            stack.append((cp, stop_))
        cps.sort()
        if not cps:
            return start_ms, end_ms

        cp_idx = cps[-1]
        cp_ms = int(timestamps_ms[cp_idx])
        cp_offset_from_start = cp_ms - start_ms
        if cp_offset_from_start < 0:
            cp_offset_from_start = 0

        trim_start_sample = int(cp_offset_from_start / 1000 * self.sample_rate)
        trim_start_ms = start_ms + trim_start_sample
        new_duration_ms = end_ms - trim_start_ms
        if new_duration_ms < cfg.cp_min_segment_ms:
            return start_ms, end_ms

        return trim_start_ms, end_ms

    def _detect_speaker_change_by_embedding(self) -> Tuple[bool, Optional[dict]]:
        cfg = CHANGE_DETECTOR_CONFIG

        with self._embedding_lock:
            emb_buffer = list(self._embedding_buffer)
            ts_list = list(self._embedding_timestamps_ms)

        n = len(emb_buffer)
        if n < cfg.embedding_min_for_detection:
            return False, None

        timestamps_arr = np.array(ts_list)
        elapsed_ms = int(timestamps_arr[-1] - timestamps_arr[0])
        if elapsed_ms < cfg.warmup_duration_ms:
            return False, None

        norms = np.array([np.linalg.norm(e) for e in emb_buffer])
        valid_mask = norms > 1e-6
        embs_raw = np.array(emb_buffer)[valid_mask]
        embs_valid = np.array([
            e / (np.linalg.norm(e) + 1e-8) for e in embs_raw
        ])
        timestamps_valid = np.array(ts_list)[valid_mask]

        if len(embs_valid) < cfg.embedding_min_for_detection:
            return False, None

        segment_duration_ms = int(timestamps_arr[-1] - timestamps_arr[0])
        if segment_duration_ms < cfg.min_segment_duration_ms:
            return False, None

        current_time_ms = int(timestamps_valid[-1])
        if current_time_ms - self._last_change_detected_ms < cfg.min_change_interval_ms:
            return False, None

        n_v = len(embs_valid)

        global_reference = np.median(embs_valid, axis=0)
        global_reference = global_reference / (np.linalg.norm(global_reference) + 1e-8)

        global_distances = np.array([
            float(1.0 - np.clip(np.dot(emb, global_reference), -1.0, 1.0))
            for emb in embs_valid
        ])

        if cfg.use_sliding_window and n_v >= cfg.sliding_window_size:
            window_size = cfg.sliding_window_size
            window_start = max(0, n_v - window_size - cfg.change_confirm_count)
            window_embs = embs_valid[window_start:window_start + window_size]
            window_ref = np.median(window_embs, axis=0)
            window_ref = window_ref / (np.linalg.norm(window_ref) + 1e-8)

            window_distances = np.array([
                float(1.0 - np.clip(np.dot(emb, window_ref), -1.0, 1.0))
                for emb in embs_valid
            ])
        else:
            window_distances = global_distances
            window_ref = global_reference

        pairwise_dists = []
        for i in range(n_v):
            for j in range(i + 1, n_v):
                d = float(1.0 - np.clip(np.dot(embs_valid[i], embs_valid[j]), -1.0, 1.0))
                pairwise_dists.append(d)
        pairwise_dists = np.array(pairwise_dists)
        max_pairwise = float(np.max(pairwise_dists)) if len(pairwise_dists) > 0 else 0.0

        mean_d = float(np.mean(window_distances))
        std_d = float(np.std(window_distances)) + 1e-8

        if cfg.use_dynamic_threshold:
            dynamic_threshold = mean_d + cfg.dynamic_factor * std_d
            threshold = max(cfg.change_distance_threshold, dynamic_threshold)
            threshold = min(threshold, 0.85)
        else:
            threshold = cfg.change_distance_threshold

        confirm_count = cfg.change_confirm_count
        if n_v < confirm_count + 2:
            return False, None

        recent_distances = window_distances[-confirm_count:]

        jump_detected = False
        if cfg.detect_jump_only and len(window_distances) >= 3:
            baseline = np.mean(window_distances[:-confirm_count]) if len(window_distances) > confirm_count + 1 else mean_d
            recent_high = recent_distances - baseline
            jump_count = sum(1 for d in recent_high if d > cfg.jump_threshold)
            early_mean = np.mean(window_distances[:-confirm_count]) if len(window_distances) > confirm_count + 1 else mean_d
            recent_mean = np.mean(recent_distances)
            is_jump = (recent_mean - early_mean) > cfg.jump_threshold * 1.2
            cluster_evidence = max_pairwise > cfg.jump_threshold * 1.5
            jump_detected = (jump_count >= confirm_count) and is_jump and cluster_evidence
        else:
            all_exceed = all(d > threshold for d in recent_distances)
            recent_mean = float(np.mean(recent_distances))
            recent_exceeds_mean = recent_mean > mean_d + 0.03
            cluster_bimodal = max_pairwise > threshold * 0.8
            jump_detected = all_exceed and recent_exceeds_mean and cluster_bimodal

        global_recent = global_distances[-confirm_count:]
        global_mean = float(np.mean(global_distances))
        global_exceed = np.mean(global_recent) > global_mean + 0.05
        global_threshold = global_mean + 0.4 * float(np.std(global_distances))
        global_threshold = min(global_threshold, 0.70)
        global_confirmed = np.mean(global_recent) > global_threshold

        change_confirmed = jump_detected and (global_exceed or global_confirmed)

        if change_confirmed:
            self._last_change_detected_ms = current_time_ms

            emb_distances = list(zip(
                [int(t) for t in timestamps_valid],
                [float(d) for d in window_distances]
            ))

            first_drift = None
            for ts, d in emb_distances:
                if d > threshold:
                    first_drift = (ts, d)
                    break

            early_dist = np.mean(window_distances[:-confirm_count]) if len(window_distances) > confirm_count + 2 else mean_d
            jump_magnitude = float(np.mean(recent_distances) - early_dist)

            debug_info = {
                "current_time_ms": current_time_ms,
                "segment_duration_ms": segment_duration_ms,
                "d": float(recent_distances[-1]),
                "mean_d": float(mean_d),
                "pair_max": float(max_pairwise),
                "threshold": float(threshold),
                "valid_count": len(embs_valid),
                "first_drift": first_drift,
                "emb_distances": emb_distances,
                "timestamps_first": int(timestamps_arr[0]),
                "timestamps_last": int(timestamps_arr[-1]),
                "total_samples_in_buffer": int(self._total_samples_processed - self.speech_start_sample),
                "speech_start_sample": int(self.speech_start_sample),
                "total_processed": int(self._total_samples_processed),
                "confirm_count": int(confirm_count),
                "jump_magnitude": jump_magnitude,
                "baseline": early_dist,
                "distances": window_distances.tolist(),
                "timestamps_ms_arr": timestamps_valid.tolist(),
                "global_distances": global_distances.tolist(),
                "global_threshold": float(global_threshold),
            }
            return True, debug_info

        return False, None

    def _update_state(self, is_speech: bool, chunk: np.ndarray) -> Optional[SpeechSegment]:
        if self.state == "idle":
            if is_speech:
                self.state = "speech"
                pre_roll_samples = sum(len(item) for item in self._pre_roll_buffer)
                self._current_pre_roll_samples = pre_roll_samples
                self._seen_speech = True
                self.speech_start_sample = max(0, self._total_samples_processed - pre_roll_samples)
                self.speech_buffer = self._pre_roll_buffer
                self._pre_roll_buffer = []
                self.silence_samples = 0
                self.speech_buffer.append(chunk)
            else:
                self._append_pre_roll(chunk)

        elif self.state == "speech":
            self.speech_buffer.append(chunk)

            current_time_ms = int(self._total_samples_processed * 1000 / self.sample_rate)
            is_in_cooldown = current_time_ms < self._speaker_change_cooldown_until_ms

            voice_changed, change_info = self._detect_speaker_change_by_embedding()
            if voice_changed and len(self.speech_buffer) >= 3:
                if is_in_cooldown:
                    pass
                else:
                    total_samples = sum(len(x) for x in self.speech_buffer)
                    audio_data = np.concatenate(self.speech_buffer)
                    start_ms = int(self.speech_start_sample * 1000 / self.sample_rate)
                    end_ms = int((self.speech_start_sample + total_samples) * 1000 / self.sample_rate)

                    info = change_info or {}
                    change_det_ms = info.get("current_time_ms", 0)
                    first_drift = info.get("first_drift")
                    distances = info.get("distances", [])
                    timestamps_cp = info.get("timestamps_ms_arr", [])

                    audio_data_trimmed = audio_data
                    _trimmed = False

                    if CHANGE_DETECTOR_CONFIG.offline_changepoint and len(distances) >= 4 and len(timestamps_cp) == len(distances):
                        ts_arr = np.array(timestamps_cp, dtype=np.int64)
                        d_arr = np.array(distances, dtype=np.float64)
                        trim_start_ms, trim_end_ms = self._find_changepoint_offline(
                            ts_arr, d_arr, start_ms, end_ms
                        )
                        if trim_start_ms > start_ms:
                            trim_sample = int((trim_start_ms - start_ms) / 1000 * self.sample_rate)
                            audio_data_trimmed = audio_data[trim_sample:]
                            start_ms = trim_start_ms
                            _trimmed = True

                    overlap_samples = int(SEGMENT_OVERLAP_TAIL_MS * self.sample_rate / 1000)
                    overlap_tail = audio_data_trimmed[-overlap_samples:] if len(audio_data_trimmed) >= overlap_samples else audio_data_trimmed
                    self._prev_segment_tail = overlap_tail.copy()

                    self.speech_buffer = []
                    self.speech_start_sample = self._total_samples_processed
                    self._current_pre_roll_samples = 0
                    self.silence_samples = 0
                    self._embedding_buffer.clear()
                    self._embedding_timestamps_ms.clear()

                    self._speaker_change_cooldown_until_ms = current_time_ms + self._speaker_change_cooldown_ms

                    return SpeechSegment(
                        audio_data=audio_data_trimmed,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        segment_reason="voice_change",
                        overlap_tail=self._prev_segment_tail,
                    )

            if is_speech:
                self.silence_samples = 0
            else:
                self.silence_samples += VAD_WINDOW_SIZE

            total_samples = sum(len(x) for x in self.speech_buffer)
            effective_speech_samples = max(
                0,
                total_samples - self._current_pre_roll_samples - self.silence_samples,
            )
            if (
                self.max_speech_samples is not None
                and effective_speech_samples >= self.max_speech_samples
                and effective_speech_samples >= self.min_speech_samples
            ):
                audio_data = np.concatenate(self.speech_buffer)
                start_ms = int(self.speech_start_sample * 1000 / self.sample_rate)
                end_ms = int((self.speech_start_sample + total_samples) * 1000 / self.sample_rate)
                overlap_samples = int(SEGMENT_OVERLAP_TAIL_MS * self.sample_rate / 1000)
                overlap_tail = audio_data[-overlap_samples:] if total_samples >= overlap_samples else audio_data
                self._prev_segment_tail = overlap_tail.copy()

                self.state = "speech" if is_speech else "idle"
                self.speech_buffer = []
                self.speech_start_sample = self.speech_start_sample + total_samples
                self._current_pre_roll_samples = 0
                self.silence_samples = 0
                self._embedding_buffer.clear()
                self._embedding_timestamps_ms.clear()
                return SpeechSegment(
                    audio_data=audio_data,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    segment_reason="max_duration",
                    overlap_tail=self._prev_segment_tail,
                )

            if not is_speech:
                if self.silence_samples >= self.min_silence_samples:
                    if total_samples >= self.min_speech_samples:
                        audio_data = np.concatenate(self.speech_buffer)
                        start_ms = int(self.speech_start_sample * 1000 / self.sample_rate)
                        end_ms = int((self.speech_start_sample + total_samples) * 1000 / self.sample_rate)
                        overlap_samples = int(SEGMENT_OVERLAP_TAIL_MS * self.sample_rate / 1000)
                        overlap_tail = audio_data[-overlap_samples:] if total_samples >= overlap_samples else audio_data
                        self._prev_segment_tail = overlap_tail.copy()

                        self.state = "idle"
                        self._retain_audio_tail_as_pre_roll(audio_data)
                        self.speech_buffer = []
                        self.speech_start_sample = 0
                        self._current_pre_roll_samples = 0
                        self.silence_samples = 0
                        self._embedding_buffer.clear()
                        self._embedding_timestamps_ms.clear()
                        return SpeechSegment(
                            audio_data=audio_data,
                            start_ms=start_ms,
                            end_ms=end_ms,
                            segment_reason="silence_timeout",
                            overlap_tail=self._prev_segment_tail,
                        )
                    else:
                        self.state = "idle"
                        if self.speech_buffer:
                            self._retain_audio_tail_as_pre_roll(np.concatenate(self.speech_buffer))
                        self.speech_buffer = []
                        self.speech_start_sample = 0
                        self._current_pre_roll_samples = 0
                        self.silence_samples = 0
                        self._embedding_buffer.clear()
                        self._embedding_timestamps_ms.clear()

        return None
