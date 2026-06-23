"""
SenseVoice engine adapter.

The model API is provided by FunASR. Imports stay inside ``load()`` so the
backend can still start in environments where SenseVoice dependencies are not
installed yet.
"""

from __future__ import annotations

import asyncio
import importlib
import io
import logging
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from app.config import get_settings
from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions, Segment

logger = logging.getLogger(__name__)
settings = get_settings()

_SAMPLE_RATE = 16_000


class SenseVoiceEngine(BaseASREngine):
    """Adapter for local SenseVoiceSmall offline inference."""

    ENGINE_NAME = "sensevoice"

    def __init__(
        self,
        model_dir: str | None = None,
        device: str | None = None,
        src_path: str | None = None,
        batch_size_s: int | None = None,
        **extra: Any,
    ) -> None:
        self._model_dir = Path(model_dir or settings.sensevoice_model_path())
        self._device = device or settings.default_sensevoice_device
        configured_src = src_path or settings.sensevoice_src_path
        self._src_path = Path(configured_src) if configured_src else None
        self._batch_size_s = batch_size_s or settings.sensevoice_batch_size_s
        self._extra = extra
        self._model: Any = None
        self._postprocess: Any = None
        self._runtime_device = self._device

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    async def load(self) -> None:
        if self._model is not None:
            return

        self._validate_paths()
        self._ensure_src_path()

        try:
            from funasr import AutoModel
            from funasr.utils.postprocess_utils import rich_transcription_postprocess
        except ImportError as exc:
            raise RuntimeError(
                "SenseVoice requires funasr and torch. Install the SenseVoice/FunASR "
                "dependencies before loading this engine."
            ) from exc

        importlib.import_module("model")
        kwargs = {
            "model": str(self._model_dir),
            "trust_remote_code": False,
            "device": self._resolve_device(),
            "disable_update": True,
        }
        kwargs.update(self._extra)

        logger.info("Loading SenseVoice model from %s on %s.", self._model_dir, self._runtime_device)
        loop = asyncio.get_running_loop()
        self._model = await loop.run_in_executor(None, lambda: AutoModel(**kwargs))
        self._postprocess = rich_transcription_postprocess
        logger.info("SenseVoice model loaded.")

    async def unload(self) -> None:
        if self._model is not None:
            del self._model
            self._model = None
            self._postprocess = None
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
            logger.info("SenseVoice model unloaded.")

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
        sample_rate, audio = _decode_audio(audio_bytes)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: self._run_inference(sample_rate, audio, opts),
        )

    def _run_inference(
        self,
        sample_rate: int,
        audio: np.ndarray,
        opts: EngineOptions,
    ) -> ASRResult:
        assert self._model is not None

        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            sf.write(tmp.name, audio, sample_rate, subtype="PCM_16")
            res = self._model.generate(
                input=tmp.name,
                cache={},
                language=opts.language or "auto",
                use_itn=True,
                batch_size_s=self._batch_size_s,
                merge_vad=True,
                merge_length_s=15,
            )

        raw = res[0] if res else {"text": ""}
        text = str(raw.get("text") or "").strip()
        if self._postprocess is not None:
            text = self._postprocess(text)

        duration = len(audio) / float(sample_rate)
        segments = [Segment(start=0.0, end=duration, text=text)] if text else []
        language = opts.language
        if raw.get("language"):
            language = str(raw.get("language"))

        return ASRResult(
            full_text=text,
            segments=segments,
            language=language,
            engine_name=self.name,
            confidence=raw.get("confidence"),
            raw={
                "model_name": "SenseVoiceSmall",
                "model_dir": str(self._model_dir),
                "result": raw,
            },
        )

    def info(self) -> dict[str, Any]:
        base = super().info()
        base.update(
            {
                "model_name": "SenseVoiceSmall",
                "device": self._runtime_device,
                "configured_device": self._device,
                "model_dir": str(self._model_dir),
                "languages": ["zh", "en", "yue", "ja", "ko"],
            }
        )
        return base

    def _resolve_device(self) -> str:
        if self._device.startswith("cuda"):
            try:
                import torch

                if not torch.cuda.is_available():
                    logger.warning("CUDA requested for SenseVoice but is not available; falling back to CPU.")
                    self._runtime_device = "cpu"
                    return self._runtime_device
            except ImportError:
                self._runtime_device = "cpu"
                return self._runtime_device
        self._runtime_device = self._device
        return self._runtime_device

    def _ensure_src_path(self) -> None:
        if self._src_path is None:
            raise RuntimeError("SENSEVOICE_SRC_PATH is not configured in backend/.env")
        src = str(self._src_path)
        if src not in sys.path:
            sys.path.insert(0, src)

    def _validate_paths(self) -> None:
        if not self._model_dir.exists():
            raise RuntimeError(f"SenseVoice model directory not found: {self._model_dir}")
        if not (self._model_dir / "model.pt").exists():
            raise RuntimeError(f"SenseVoice model.pt not found in {self._model_dir}")
        if self._src_path is None:
            raise RuntimeError("SENSEVOICE_SRC_PATH is not configured in backend/.env")
        if not (self._src_path / "model.py").exists():
            raise RuntimeError(f"SenseVoice reference model.py not found: {self._src_path}")


def _decode_audio(audio_bytes: bytes) -> tuple[int, np.ndarray]:
    try:
        audio, sr = sf.read(io.BytesIO(audio_bytes), dtype="int16", always_2d=False)
    except Exception:
        return _decode_audio_ffmpeg(audio_bytes)

    if audio.ndim > 1:
        audio = audio.mean(axis=1).astype(np.int16)
    if sr != _SAMPLE_RATE:
        import librosa  # type: ignore[import]

        audio_f = audio.astype(np.float32) / 32768.0
        audio_f = librosa.resample(audio_f, orig_sr=sr, target_sr=_SAMPLE_RATE)
        audio = np.clip(audio_f * 32767.0, -32768, 32767).astype(np.int16)
        sr = _SAMPLE_RATE
    return sr, np.ascontiguousarray(audio)


def _decode_audio_ffmpeg(audio_bytes: bytes) -> tuple[int, np.ndarray]:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError(
            "ffmpeg is required to decode this audio format for SenseVoice, but it was not found."
        )

    # Android MediaRecorder emits MP4/M4A, which libsndfile usually cannot read
    # from BytesIO. A temporary file gives ffmpeg a seekable container input.
    with tempfile.NamedTemporaryFile(suffix=".audio") as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        cmd = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            tmp.name,
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            str(_SAMPLE_RATE),
            "pipe:1",
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False)

    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="ignore").strip()
        raise RuntimeError(f"ffmpeg could not decode audio for SenseVoice: {stderr}")
    audio = np.frombuffer(proc.stdout, dtype=np.int16)
    if audio.size == 0:
        raise RuntimeError("ffmpeg decoded zero audio samples for SenseVoice.")
    return _SAMPLE_RATE, np.ascontiguousarray(audio)
