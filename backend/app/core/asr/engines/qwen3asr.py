"""Qwen3-ASR engine adapter."""

from __future__ import annotations

import asyncio
import gc
import io
import logging
import math
import tempfile
import time
from pathlib import Path
from typing import Any

import soundfile as sf
import numpy as np

from app.config import get_settings
from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions, Segment
from app.core.json_utils import json_safe
from app.core.model_cache import huggingface_cache_dir

logger = logging.getLogger(__name__)
settings = get_settings()


class Qwen3ASREngine(BaseASREngine):
    """Adapter for Qwen/Qwen3-ASR-1.7B offline transcription."""

    ENGINE_NAME = "qwen3asr"
    ENGINE_LABEL = "Qwen3-ASR"
    INSTALL_EXTRA = "qwen3asr"

    def __init__(
        self,
        model_name: str | None = None,
        model_dir: str | None = None,
        device: str | None = None,
        torch_dtype: str | None = None,
        **extra: Any,
    ) -> None:
        self._model_name = model_name or settings.default_qwen3asr_model
        self._model_dir = Path(model_dir or settings.qwen3asr_model_path(self._model_name))
        self._device = device or settings.default_qwen3asr_device
        self._torch_dtype = torch_dtype or settings.qwen3asr_torch_dtype
        self._extra = extra
        self._model: Any = None

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    async def load(self) -> None:
        if self._model is not None:
            return

        try:
            from qwen_asr import Qwen3ASRModel  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError(
                f"{self.ENGINE_LABEL} requires qwen-asr. Install it with: "
                f"pip install 'asr-backend[{self.INSTALL_EXTRA}]'"
            ) from exc

        model_ref = str(self._model_dir) if _path_has_model_files(self._model_dir) else self._model_name
        kwargs: dict[str, Any] = dict(self._extra)
        if model_ref == self._model_name:
            kwargs.setdefault("cache_dir", str(huggingface_cache_dir(settings)))
        self._device, self._torch_dtype = _resolve_runtime_options(self._device, self._torch_dtype)
        _require_cuda_if_selected(self._device)
        if self._device:
            kwargs.setdefault("device_map", self._device)
        if self._torch_dtype and self._torch_dtype != "auto":
            kwargs.setdefault("dtype", _resolve_torch_dtype(self._torch_dtype))

        logger.info("Loading %s model '%s' from %s.", self.ENGINE_LABEL, self._model_name, model_ref)
        loop = asyncio.get_running_loop()
        self._model = await loop.run_in_executor(
            None,
            lambda: _load_qwen_model(Qwen3ASRModel, model_ref, kwargs),
        )
        logger.info("%s model loaded.", self.ENGINE_LABEL)

    async def unload(self) -> None:
        if self._model is not None:
            del self._model
            self._model = None
            # Transformers modules can retain reference cycles. Without a full
            # collection, empty_cache cannot release live model tensors and a
            # subsequent model switch may keep several GB of VRAM occupied.
            gc.collect()
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
            logger.info("%s model unloaded.", self.ENGINE_LABEL)

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    async def transcribe(
        self,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        if not self.is_loaded:
            await self.load()

        opts = options or EngineOptions()
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: self._run_inference(audio_bytes, opts),
        )

    def _run_inference(self, audio_bytes: bytes, opts: EngineOptions) -> ASRResult:
        assert self._model is not None

        started = time.perf_counter()
        # The SDK supports (waveform, sample_rate). Decode supported containers
        # directly and use the same HQ soxr resampler as librosa's default.
        # This avoids librosa.load's costly first-use imports on Windows, and
        # also avoids writing and reading a second copy of each WAV recording.
        audio_path: Path | None = None
        decoded = False
        decode_started = time.perf_counter()
        try:
            try:
                audio_input = _decode_qwen_audio(audio_bytes)
                duration = len(audio_input[0]) / float(audio_input[1])
                decoded = True
            except sf.LibsndfileError:
                # Retain the SDK's audioread/codec fallback for a container
                # libsndfile cannot decode. Windows requires closing the writer
                # before the SDK reopens this path.
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    audio_path = Path(tmp.name)
                    tmp.write(audio_bytes)
                audio_input = str(audio_path)
                duration = _audio_duration_sec(audio_input)
            decode_sec = time.perf_counter() - decode_started
            inference_started = time.perf_counter()
            raw = self._call_model(audio_input, opts)
            sdk_inference_sec = time.perf_counter() - inference_started
        finally:
            if audio_path is not None:
                audio_path.unlink(missing_ok=True)

        format_started = time.perf_counter()
        text = _extract_text(raw).strip()
        segments = [Segment(start=0.0, end=duration, text=text)] if text else []
        language = _extract_language(raw) or opts.language

        return ASRResult(
            full_text=text,
            segments=segments,
            language=language,
            engine_name=self.name,
            raw={
                "model_name": self._model_name,
                "model_dir": str(self._model_dir),
                "device": self._device,
                "result": json_safe(raw),
                "inference_timing": {
                    # Fallback decode occurs inside the SDK; do not fabricate
                    # a separate decode timing when it cannot be observed.
                    "audio_decode_sec": decode_sec if decoded else None,
                    "audio_input_mode": "waveform" if decoded else "sdk_path",
                    "sdk_inference_sec": sdk_inference_sec,
                    "result_format_sec": time.perf_counter() - format_started,
                    "total_engine_sec": time.perf_counter() - started,
                },
            },
        )

    def _call_model(self, audio_input: Any, opts: EngineOptions) -> Any:
        return _call_qwen_model(self._model, audio_input, opts)

    def info(self) -> dict[str, Any]:
        base = super().info()
        base.update(
            {
                "model_name": self._model_name,
                "device": self._device,
                "compute_type": self._torch_dtype,
                "model_dir": str(self._model_dir),
                "languages": ["zh", "en", "yue", "ja", "ko"],
            }
        )
        return base


def _load_qwen_model(model_cls: Any, model_ref: str, kwargs: dict[str, Any]) -> Any:
    # Never silently drop device / dtype / decoder settings after an internal
    # TypeError: doing so can retry on the wrong device or a larger precision.
    return model_cls.from_pretrained(model_ref, **kwargs)


def _call_qwen_model(model: Any, audio_path: Any, opts: EngineOptions) -> Any:
    language = _qwen_language(opts.language)
    kwargs = {"language": language} if language else {}
    for method_name in ("transcribe", "generate", "recognize"):
        method = getattr(model, method_name, None)
        if method is None:
            continue
        try:
            return method(audio=audio_path, **kwargs)
        except TypeError:
            pass
        try:
            return method(audio_path, **kwargs)
        except TypeError:
            return method(audio_path)
    if callable(model):
        try:
            return model(audio_path, **kwargs)
        except TypeError:
            return model(audio_path)
    raise RuntimeError("Loaded Qwen3-ASR model does not expose a supported inference method.")


def _extract_text(raw: Any) -> str:
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        for key in ("text", "transcription", "result", "sentence"):
            value = raw.get(key)
            if isinstance(value, str):
                return value
        if isinstance(raw.get("results"), list):
            return _extract_text(raw["results"])
    if isinstance(raw, list):
        return " ".join(_extract_text(item).strip() for item in raw).strip()
    for attr in ("text", "transcription", "result", "sentence"):
        value = getattr(raw, attr, None)
        if isinstance(value, str):
            return value
    return str(raw) if raw is not None else ""


def _extract_language(raw: Any) -> str | None:
    if isinstance(raw, dict):
        value = raw.get("language") or raw.get("lang")
        return str(value) if value else None
    if isinstance(raw, list):
        for item in raw:
            language = _extract_language(item)
            if language:
                return language
    value = getattr(raw, "language", None) or getattr(raw, "lang", None)
    if value:
        return str(value)
    return None


def _qwen_language(language: str | None) -> str | None:
    if not language:
        return None
    normalized = language.strip()
    if not normalized:
        return None
    mapping = {
        "zh": "Chinese",
        "zh-cn": "Chinese",
        "zh_hans": "Chinese",
        "en": "English",
        "yue": "Cantonese",
        "ja": "Japanese",
        "ko": "Korean",
        "fr": "French",
        "de": "German",
        "it": "Italian",
        "es": "Spanish",
        "pt": "Portuguese",
        "ru": "Russian",
        "ar": "Arabic",
        "hi": "Hindi",
        "th": "Thai",
        "vi": "Vietnamese",
        "tr": "Turkish",
        "id": "Indonesian",
        "ms": "Malay",
        "nl": "Dutch",
        "sv": "Swedish",
        "da": "Danish",
        "fi": "Finnish",
        "pl": "Polish",
        "cs": "Czech",
        "fil": "Filipino",
        "fa": "Persian",
        "el": "Greek",
        "hu": "Hungarian",
        "mk": "Macedonian",
        "ro": "Romanian",
    }
    return mapping.get(normalized.lower(), normalized)


def _resolve_torch_dtype(name: str) -> Any:
    import torch

    mapping = {
        "bf16": torch.bfloat16,
        "bfloat16": torch.bfloat16,
        "fp16": torch.float16,
        "float16": torch.float16,
        "fp32": torch.float32,
        "float32": torch.float32,
    }
    return mapping.get(name.lower(), name)


def _resolve_runtime_options(device: str, dtype: str) -> tuple[str, str]:
    """Only an explicit ``auto`` device selection permits CPU fallback.

    CUDA remains the default, including managed Windows installs. Check the
    installed torch runtime for ``auto`` because a machine with an NVIDIA GPU
    can still have a CPU-only PyTorch build.
    """
    if device == "auto":
        import torch

        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    if dtype == "auto":
        dtype = "float32" if device == "cpu" else "bfloat16"
    return device, dtype


def _require_cuda_if_selected(device: str) -> None:
    """Reject unavailable CUDA before loading weights; never change devices."""
    if device != "cuda" and not device.startswith("cuda:"):
        return
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError(
            f"No CUDA GPUs are available for device '{device}'. "
            "A CUDA-enabled PyTorch build and a working NVIDIA driver are required. "
            "Select device='cpu' or device='auto' explicitly to allow CPU execution."
        )


def _audio_duration_sec(path: str) -> float:
    try:
        info = sf.info(path)
        if info.samplerate:
            return round(info.frames / float(info.samplerate), 3)
    except Exception:
        logger.debug("Could not read audio duration for %s.", path, exc_info=True)
    return 0.0


def _decode_qwen_audio(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """Match SDK mono/16 kHz input without its lazy librosa file loader."""
    with io.BytesIO(audio_bytes) as source:
        waveform, sample_rate = sf.read(source, dtype="float32", always_2d=False)
    if waveform.ndim == 2:
        waveform = np.mean(waveform, axis=-1).astype(np.float32)
    if sample_rate != 16000:
        import soxr

        length = math.ceil(len(waveform) * 16000 / sample_rate)
        waveform = soxr.resample(waveform, sample_rate, 16000, quality="HQ")
        # librosa.resample defaults to fix=True: preserve its exact ceil-length
        # convention, including fractional 44.1 kHz -> 16 kHz conversions.
        if len(waveform) < length:
            waveform = np.pad(waveform, (0, length - len(waveform)))
        else:
            waveform = waveform[:length]
    return np.asarray(waveform, dtype=np.float32), 16000


def _path_has_model_files(path: Path) -> bool:
    if not path.exists():
        return False
    names = {"config.json", "model.safetensors", "pytorch_model.bin"}
    if any((path / name).exists() for name in names):
        return True
    return any(path.glob("*.safetensors")) or any(path.glob("*.bin"))
