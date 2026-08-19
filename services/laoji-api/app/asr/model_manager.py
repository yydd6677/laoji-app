"""
CAM++ 声纹模型管理 - 用于说话人注册和声纹比对。

注册、实时识别和长音频转写共用同一个模型实例和特征空间。

同时包含 ModelManager 类，统一管理实时转录所需的支持模型：
- Silero VAD
- CAM++ zh / en

CAM++ 的网络结构已收纳在本模块目录，不依赖其他语音识别框架。
"""

import asyncio
import copy
import hashlib
import os
import threading
from typing import Optional
from dataclasses import dataclass
import numpy as np

import torch


_CAMPPLUS_INFERENCE_LOCK = threading.Lock()
_VAD_INSTANCE_LOCK = threading.Lock()


def _resolve_model_path(path: str) -> str:
    """解析模型路径：
    - 绝对路径：原样返回
    - 相对路径（如 ./models/campplus, ../data）：相对于 backend/ 目录解析
    """
    if not path:
        return ""
    if os.path.isabs(path):
        return path

    # 始终以 backend/ 目录为基准，避免依赖 CWD
    _backend_dir = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    )

    # ./models/xxx 或 ../xxx → 相对于 backend/ 解析
    if path.startswith("./") or path.startswith("../"):
        return os.path.normpath(os.path.join(_backend_dir, path))

    # 直接以 models/ campplus silero 开头的相对路径 → 相对于 backend/
    if any(path.startswith(p) for p in ("models/", "campplus", "silero")):
        return os.path.normpath(os.path.join(_backend_dir, path))

    return path


def _get_local_model_dir() -> str:
    from app.config import settings
    path = settings.LOCAL_MODEL_DIR
    if path:
        resolved = _resolve_model_path(path)
        if os.path.isabs(resolved):
            return resolved
    backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(os.path.dirname(backend_dir), "models")


@dataclass
class ModelPaths:
    campplus_model: str
    device: str
    local_model_dir: str = ""


def _get_default_model_paths() -> ModelPaths:
    """从环境变量和配置获取默认模型路径（自动解析相对路径）"""
    from app.config import settings
    from app.asr.config import (
        CAMPPLUS_MODEL_DIR,
        LOCAL_MODEL_DIR,
        LOCAL_DEVICE,
    )

    camp_dir = os.getenv("CAMPPLUS_MODEL_DIR", CAMPPLUS_MODEL_DIR)
    local_dir = os.getenv("LOCAL_MODEL_DIR", LOCAL_MODEL_DIR)
    device = os.getenv("LOCAL_DEVICE", LOCAL_DEVICE or settings.LOCAL_DEVICE or "cuda")

    return ModelPaths(
        campplus_model=_resolve_model_path(camp_dir),
        device=device,
        local_model_dir=_resolve_model_path(local_dir),
    )


class ModelManager:
    """
    模型管理器 - 单例模式，全局共享模型实例

    使用方式:
        manager = ModelManager.get_instance()
        await manager.initialize()
        camp_model = manager.get_camp_model()
    """

    _instance: Optional["ModelManager"] = None
    def __init__(self):
        self._lock = asyncio.Lock()
        self._vad_init_lock = asyncio.Lock()
        self.camp_model = None
        self.vad_model = None
        self._vad_jit_file = None
        self.vad_model_samplerate = 16000
        self._initialized = False
        self._initialization_task: asyncio.Task | None = None
        self._paths = _get_default_model_paths()
        self._camp_device = self._paths.device
        self._camp_model_revision = "campplus-zh-unavailable"

    @classmethod
    def get_instance(cls) -> "ModelManager":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def initialize(self) -> None:
        """Load the one shared VAD/CAM++ pair and let concurrent callers await it."""
        if self._initialized:
            return

        async with self._lock:
            if self._initialized:
                return
            task = self._initialization_task
            if task is None:
                task = asyncio.create_task(self._initialize_models())
                self._initialization_task = task

        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            raise
        except Exception:
            async with self._lock:
                if self._initialization_task is task:
                    self._initialization_task = None
            raise

    async def initialize_vad(self) -> None:
        """Make text segmentation ready without waiting for CAM++ weights."""
        if self.vad_model is not None:
            return
        async with self._vad_init_lock:
            if self.vad_model is not None:
                return
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self._load_vad)
            if self.vad_model is None:
                raise RuntimeError("Silero VAD 未能加载")

    async def _initialize_models(self) -> None:
        """Load the required Chinese support models exactly once."""

        print("", flush=True)
        print("[ModelManager] =========================================================", flush=True)
        print("[ModelManager]          Qwen3-ASR 支持模型加载", flush=True)
        print("[ModelManager] =========================================================", flush=True)
        loop = asyncio.get_event_loop()

        # ── Silero VAD ──────────────────────────────────────────────
        print("[ModelManager] [1/2] Silero VAD (语音活动检测)...", flush=True)
        _vad_ok = False
        try:
            await self.initialize_vad()
            if self.vad_model is not None:
                print("[ModelManager]       [PASS] Silero VAD 加载成功", flush=True)
                _vad_ok = True
            else:
                print("[ModelManager]       [FAIL] Silero VAD 加载失败（模型为空）", flush=True)
        except Exception as e:
            print(f"[ModelManager]       [FAIL] Silero VAD 加载失败: {e}", flush=True)

        # ── CAM++ 中文 ─────────────────────────────────────────────
        print("[ModelManager] [2/2] CAM++ 声纹 (中文)...", flush=True)
        _camp_ok = False
        try:
            await loop.run_in_executor(None, self._load_campplus)
            if self.camp_model is not None:
                print("[ModelManager]       [PASS] CAM++ 中文声纹模型加载成功", flush=True)
                _camp_ok = True
            else:
                print("[ModelManager]       [FAIL] CAM++ 中文声纹模型加载失败（模型为空）", flush=True)
        except Exception as e:
            print(f"[ModelManager]       [FAIL] CAM++ 中文声纹模型加载失败: {e}", flush=True)

        # ── 汇总 ───────────────────────────────────────────────────
        _required = [_vad_ok, _camp_ok]
        _total = len(_required)
        _passed = sum(1 for _f in _required if _f)
        print("", flush=True)
        print("[ModelManager] =========================================================", flush=True)
        print(f"[ModelManager]  加载结果汇总（共 {_total} 个核心模型）", flush=True)
        print("[ModelManager] ---------------------------------------------------------", flush=True)
        _vad_s = "[PASS]" if _vad_ok else "[FAIL]"
        _camp_s = "[PASS]" if _camp_ok else "[FAIL]"
        print(f"[ModelManager]   1. Silero VAD (语音活动检测)     {_vad_s}", flush=True)
        print(f"[ModelManager]   2. CAM++ 中文声纹               {_camp_s}", flush=True)
        print("[ModelManager] ---------------------------------------------------------", flush=True)
        print(f"[ModelManager]  通过: {_passed}/{_total}   设备: {self._paths.device}", flush=True)
        print("[ModelManager] =========================================================", flush=True)

        if not _vad_ok or not _camp_ok:
            raise RuntimeError("VAD 或中文声纹模型未能加载")
        self._initialized = True
        print("[ModelManager]  就绪: Qwen3-ASR 支持模型已加载完成，可以开始会议", flush=True)

    def _load_campplus(self) -> None:
        """加载 CAM++ 中文声纹模型"""
        self.camp_model = None
        try:
            model_dir = self._paths.campplus_model
            print(f"[ModelManager] 加载 CAM++ 中文声纹模型 from: {model_dir}")

            if not os.path.exists(model_dir):
                print(f"[ModelManager] CAM++ 中文模型目录不存在: {model_dir}，跳过")
                return

            import yaml
            from app.asr.campplus_model import CAMPPlus

            config_path = os.path.join(model_dir, "config.yaml")
            if not os.path.exists(config_path):
                print(f"[ModelManager] CAM++ config.yaml 不存在，跳过")
                return

            with open(config_path, "r", encoding="utf-8") as f:
                model_conf = yaml.safe_load(f)

            camp_config = model_conf.get("model_conf", {})
            model = CAMPPlus(
                feat_dim=camp_config.get("feat_dim", 80),
                embedding_size=camp_config.get("embedding_size", 192),
                growth_rate=camp_config.get("growth_rate", 32),
                bn_size=camp_config.get("bn_size", 4),
                init_channels=camp_config.get("init_channels", 128),
                config_str=camp_config.get("config_str", "batchnorm-relu"),
                memory_efficient=False,
                output_level=camp_config.get("output_level", "segment"),
            )

            model_file = os.path.join(model_dir, model_conf.get("model_file") or "campplus_cn_common.bin")
            print(f"[ModelManager] CAM++ 中文模型权重文件: {model_file}")

            target_device = self._paths.device
            try:
                state_dict = torch.load(model_file, map_location=target_device)
            except (RuntimeError, AssertionError):
                print("[ModelManager] CUDA 加载失败，尝试 CPU 模式...")
                target_device = "cpu"
                state_dict = torch.load(model_file, map_location=torch.device("cpu"))
            if isinstance(state_dict, dict) and "state_dict" in state_dict:
                state_dict = state_dict["state_dict"]

            model.load_state_dict(state_dict, strict=False)
            try:
                model.to(target_device)
            except (RuntimeError, AssertionError):
                print(f"[ModelManager] CUDA 不可用，使用 CPU...")
                target_device = "cpu"
                model.to(torch.device("cpu"))
            model.eval()
            self._camp_device = str(target_device)
            self.camp_model = model
            digest = hashlib.sha256()
            with open(model_file, "rb") as weights:
                for chunk in iter(lambda: weights.read(1024 * 1024), b""):
                    digest.update(chunk)
            self._camp_model_revision = f"campplus-zh-{digest.hexdigest()[:24]}"
            print(f"[ModelManager] CAM++ 中文声纹模型加载成功")

        except Exception as e:
            self.camp_model = None
            print(f"[ModelManager] CAM++ 中文声纹模型加载失败: {e}")

    def _load_vad(self) -> None:
        """加载 Silero VAD 模型（优先项目 ./models，其次联网下载）"""
        self.vad_model = None
        self._vad_jit_file = None
        try:
            torch.set_num_threads(1)

            # 优先级1: 项目根目录的 ./models（通过 LOCAL_MODEL_DIR 配置）
            local_master_dir = os.path.join(
                _get_local_model_dir(),
                "silero-vad", "snakers4_silero-vad_master"
            )
            local_v1 = os.path.join(local_master_dir, "files", "silero-vad", "silero_vad.jit")
            local_v2 = os.path.join(local_master_dir, "src", "silero_vad", "data", "silero_vad.jit")
            hub_master_dir = os.path.join(torch.hub.get_dir(), "snakers4_silero-vad_master")
            hub_v2 = os.path.join(hub_master_dir, "src", "silero_vad", "data", "silero_vad.jit")

            model, utils = None, None

            if os.path.exists(local_v1):
                print(f"[ModelManager] 发现项目本地 Silero VAD: {local_v1}", flush=True)
                os.environ["TORCH_HUB_DIR"] = os.path.join(_get_local_model_dir(), "silero-vad")
                model, utils = self._load_silero_hub(local_master_dir)
            elif os.path.exists(local_v2):
                print(f"[ModelManager] 发现项目本地 Silero VAD: {local_v2}", flush=True)
                self._vad_jit_file = local_v2
                model, utils = self._load_silero_from_local(os.path.join(local_master_dir, "src", "silero_vad"))
            elif os.path.exists(hub_v2):
                # The streaming path only needs the JIT model. Loading the
                # cached hub package imports optional torchaudio before the
                # model is created, which makes the compact environment fail
                # even though soundfile/scipy already provide the file helper.
                print(f"[ModelManager] 发现 Torch Hub Silero VAD: {hub_v2}", flush=True)
                self._vad_jit_file = hub_v2
                model, utils = self._load_silero_from_local(
                    os.path.join(hub_master_dir, "src", "silero_vad")
                )
            else:
                print(f"[ModelManager] 未找到本地 Silero VAD，尝试联网下载...", flush=True)
                torch_hub_dir = os.path.join(_get_local_model_dir(), "silero-vad")
                os.makedirs(torch_hub_dir, exist_ok=True)
                os.environ["TORCH_HUB_DIR"] = torch_hub_dir
                model, utils = self._load_silero_hub("snakers4/silero-vad")

            if model is None:
                raise RuntimeError("VAD 模型加载返回了 None")

            (get_speech_timestamps, _, read_audio, _, _) = utils
            self.vad_model = model
            self.vad_get_speech_timestamps = get_speech_timestamps
            self.vad_read_audio = read_audio
            print("[ModelManager] Silero VAD 模型加载成功", flush=True)

        except Exception as e:
            print(f"[ModelManager] Silero VAD 模型加载失败: {e}", flush=True)

    def _load_silero_hub(self, repo_or_dir: str):
        """Load both legacy and current Silero hubconf signatures.

        Older hubconf files accept ``map_location`` while newer Silero
        releases select the device internally and reject that keyword.  The
        fallback is intentionally limited to this signature mismatch so real
        model/download errors still surface through the normal readiness gate.
        """
        try:
            return torch.hub.load(
                repo_or_dir=repo_or_dir,
                model="silero_vad",
                trust_repo=True,
                map_location=self._paths.device,
            )
        except TypeError as error:
            if "map_location" not in str(error):
                raise
            print(
                "[ModelManager] Silero hubconf 不支持 map_location，使用兼容调用",
                flush=True,
            )
            return torch.hub.load(
                repo_or_dir=repo_or_dir,
                model="silero_vad",
                trust_repo=True,
            )

    def _load_silero_from_local(self, src_dir: str):
        """直接从本地 .jit 文件加载 Silero VAD"""
        jit_file = os.path.join(src_dir, "data", "silero_vad.jit")
        if not os.path.exists(jit_file):
            raise FileNotFoundError(f"找不到 Silero VAD .jit 文件: {jit_file}")

        print(f"[ModelManager] 直接加载本地 .jit 模型: {jit_file}", flush=True)

        target_device = self._paths.device
        try:
            model = torch.jit.load(jit_file, map_location=target_device)
        except (RuntimeError, AssertionError):
            print(f"[ModelManager] {target_device} .jit 加载失败，尝试 CPU 模式...")
            model = torch.jit.load(jit_file, map_location=torch.device("cpu"))

        model.eval()

        def read_audio(path):
            import math
            import soundfile
            from scipy import signal

            waveform, sr = soundfile.read(path, dtype="float32", always_2d=True)
            waveform = waveform.mean(axis=1)
            if sr != 16000:
                divisor = math.gcd(int(sr), 16000)
                waveform = signal.resample_poly(waveform, 16000 // divisor, int(sr) // divisor)
            return np.asarray(waveform, dtype=np.float32)

        utils = (lambda *a, **kw: [], lambda: None, read_audio, lambda: None, lambda: None)
        return model, utils

    def get_camp_model(self):
        return self.camp_model

    def get_vad_model(self):
        return self.vad_model

    def create_vad_model(self):
        """Create an independent stateful VAD instance for one audio session."""
        if self.vad_model is None:
            return None
        with _VAD_INSTANCE_LOCK:
            if self._vad_jit_file:
                target_device = self._paths.device
                try:
                    model = torch.jit.load(
                        self._vad_jit_file,
                        map_location=target_device,
                    )
                except (RuntimeError, AssertionError):
                    model = torch.jit.load(
                        self._vad_jit_file,
                        map_location=torch.device("cpu"),
                    )
            else:
                model = copy.deepcopy(self.vad_model)
            model.eval()
            if hasattr(model, "reset_states"):
                model.reset_states()
            return model

    def is_initialized(self) -> bool:
        return self._initialized

    def required_models_ready(self) -> bool:
        return bool(
            self._initialized
            and self.vad_model is not None
            and self.camp_model is not None
        )

    @property
    def device(self) -> str:
        return self._camp_device

    @property
    def camp_model_revision(self) -> str:
        return self._camp_model_revision


class SpeakerEmbeddingExtractor:
    """说话人声纹特征提取器，使用 CAM++ 模型"""

    def __init__(self, model, device: str = "cuda"):
        self.model = model
        self.device = device
        self.sample_rate = 16000

    def extract(self, audio_data: np.ndarray) -> np.ndarray:
        # The same CUDA CAM++ module is shared by all realtime sessions.
        # Concurrent forwards from separate Python worker threads can crash
        # inside libtorch, so all extractors share one process-level lock.
        with _CAMPPLUS_INFERENCE_LOCK:
            return self._extract_locked(audio_data)

    def _extract_locked(self, audio_data: np.ndarray) -> np.ndarray:
        """
        从音频数据中提取声纹特征向量（192维）
        Args:
            audio_data: numpy 数组，16kHz 采样率，float32 格式，范围 [-1, 1]
        Returns:
            192 维声纹向量
        """
        if self.model is None:
            raise RuntimeError("CAM++ 模型未加载")

        try:
            import torch
            from app.asr.campplus_features import extract_feature

            if audio_data.dtype != np.float32:
                audio_data = audio_data.astype(np.float32)

            # Speaker overlays are inference-only. Without this guard every
            # long meeting builds autograd metadata for each CAM++ window;
            # the tensors are short-lived but the CPU allocator retains the
            # resulting anonymous pages, causing candidate API RSS to grow
            # across hundreds of segments.
            with torch.inference_mode():
                audio_tensor = torch.from_numpy(audio_data).float()
                features, _, _ = extract_feature([audio_tensor])
                try:
                    features = features.to(device=self.device)
                except AssertionError:
                    self.device = "cpu"
                    features = features.to(device="cpu")

                embedding = self.model(features)

                if len(embedding.shape) > 2:
                    embedding = embedding.squeeze(0)

                embedding_np = embedding.cpu().numpy()

            if embedding_np.ndim > 1:
                embedding_np = embedding_np[0] if embedding_np.shape[0] == 1 else embedding_np.mean(axis=0)

            if np.any(np.isnan(embedding_np)):
                n_nan = np.sum(np.isnan(embedding_np))
                pct = n_nan * 100.0 / embedding_np.size
                print(f"[SpeakerEmbedding] 警告: embedding 包含 {n_nan}/{embedding_np.size} 个 NaN ({pct:.1f}%)")
                if pct < 10.0:
                    mean_val = np.nanmean(embedding_np)
                    embedding_np = np.nan_to_num(embedding_np, nan=mean_val)
                else:
                    raise ValueError(f"Embedding 失效率过高 ({pct:.1f}%)")

            return embedding_np

        except Exception as e:
            print(f"[SpeakerEmbedding] 声纹提取失败: {e}")
            raise

    def extract_from_bytes(self, audio_bytes: bytes) -> np.ndarray:
        """从字节数据中提取声纹特征"""
        audio_int16 = np.frombuffer(audio_bytes, dtype=np.int16)
        audio_float32 = audio_int16.astype(np.float32) / 32768.0
        return self.extract(audio_float32)

    def compute_similarity(self, emb1: np.ndarray, emb2: np.ndarray) -> float:
        """计算两个声纹向量的余弦相似度"""
        emb1_norm = emb1 / (np.linalg.norm(emb1) + 1e-8)
        emb2_norm = emb2 / (np.linalg.norm(emb2) + 1e-8)
        similarity = float(np.dot(emb1_norm, emb2_norm))
        return (similarity + 1.0) / 2.0

    def extract_multi_window(
        self, audio_data: np.ndarray, n_windows: int = 3, window_step_ratio: float = 0.25,
        sample_rate: int = 16000,
    ) -> list[tuple[np.ndarray, float, bool]]:
        """从音频中提取多个滑动窗口的声纹向量"""
        n_samples = len(audio_data)
        min_samples = int(self.sample_rate * 0.3)
        window_len = n_samples
        if n_samples < min_samples * n_windows:
            try:
                emb = self.extract(audio_data)
                return [(emb, 0.0, True)]
            except Exception:
                return []
        speech_ranges = self._detect_speech_ranges(audio_data, sample_rate)
        if speech_ranges and len(speech_ranges) >= 2:
            last_start, last_end = speech_ranges[-1]
            speech_len = last_end - last_start
            window_len = max(min(speech_len, n_samples // 2), int(self.sample_rate * 0.5))
            win_start = max(0, last_end - window_len)
            step = int(window_len * window_step_ratio)
        else:
            window_len = n_samples // n_windows
            step = int(window_len * window_step_ratio)
        results = []
        for i in range(n_windows):
            start = i * step
            end = min(start + window_len, n_samples)
            if end - start < min_samples:
                break
            window_audio = audio_data[start:end]
            energy = float(np.sqrt(np.mean(window_audio ** 2)))
            if energy < 1e-4:
                continue
            try:
                emb = self.extract(window_audio)
                if float(np.linalg.norm(emb)) < 1e-6:
                    continue
                results.append((emb, start / self.sample_rate, True))
            except Exception:
                results.append((np.array([]), start / self.sample_rate, False))
        return results

    def extract_fused(
        self, audio_data: np.ndarray, n_windows: int = 3,
        window_step_ratio: float = 0.25, fusion_method: str = "mean",
        sample_rate: int = 16000,
    ) -> tuple[np.ndarray, dict]:
        windows = self.extract_multi_window(audio_data, n_windows, window_step_ratio, sample_rate)
        valid = [(emb, ts) for emb, ts, ok in windows if ok]
        if not valid:
            raise ValueError("所有窗口均提取失败")
        embeddings = [emb for emb, _ in valid]
        timestamps = [ts for _, ts in valid]
        if fusion_method == "median":
            stacked = np.array(embeddings)
            fused = np.median(stacked, axis=0)
        else:
            fused = np.mean(embeddings, axis=0)
        fused = fused / (np.linalg.norm(fused) + 1e-8)
        window_scores = {}
        for idx, (emb, ts) in enumerate(valid):
            sim = float(np.dot(emb, fused))
            window_scores[f"window_{idx}_t{ts:.2f}s"] = round(sim, 4)
        mean_sim = float(np.mean(list(window_scores.values()))) if window_scores else 0.0
        std_sim = float(np.std(list(window_scores.values()))) if len(window_scores) > 1 else 0.0
        outlier_count = sum(
            1 for v in window_scores.values() if abs(v - mean_sim) > 2.5 * std_sim
        ) if std_sim > 0 else 0
        stats = {
            "n_windows": n_windows, "n_valid": len(valid),
            "window_scores": window_scores,
            "mean_sim": round(mean_sim, 4),
            "std_sim": round(std_sim, 4),
            "outlier_count": outlier_count,
            "timestamps": timestamps,
        }
        return fused, stats

    def _detect_speech_ranges(self, audio_data: np.ndarray, sample_rate: int = 16000) -> list[tuple[int, int]]:
        win_size = int(sample_rate * 0.025)
        win_step = int(win_size * 0.5)
        n_samples = len(audio_data)
        energy_threshold = 0.01
        speech_ranges = []
        in_speech = False
        speech_start = 0
        i = 0
        while i * win_step < n_samples:
            start = i * win_step
            end = min(start + win_size, n_samples)
            frame = audio_data[start:end]
            energy = float(np.sqrt(np.mean(frame ** 2)))
            if energy > energy_threshold:
                if not in_speech:
                    speech_start = start
                    in_speech = True
            else:
                if in_speech:
                    speech_ranges.append((speech_start, end))
                    in_speech = False
            i += 1
        if in_speech:
            speech_ranges.append((speech_start, n_samples))
        if not speech_ranges:
            return []
        merged = [speech_ranges[0]]
        for start, end in speech_ranges[1:]:
            if start - merged[-1][1] < int(sample_rate * 0.1):
                merged[-1] = (merged[-1][0], end)
            else:
                merged.append((start, end))
        return merged


def get_model_manager() -> ModelManager:
    """获取模型管理器实例的快捷函数"""
    return ModelManager.get_instance()
