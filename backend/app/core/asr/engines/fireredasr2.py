"""
app/core/asr/engines/fireredasr2.py
-----------------------------------
FireRedASR2 engine adapter backed by the bundled FireRedASR2S package.

The upstream model API is synchronous and expects 16 kHz mono waveform data.
This adapter keeps the rest of the backend engine-agnostic by exposing the
standard BaseASREngine lifecycle and ASRResult shape.
"""

from __future__ import annotations

import asyncio
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


class FireRedASR2Engine(BaseASREngine):
    """Adapter for FireRedASR2-AED/LLM offline transcription."""

    ENGINE_NAME = "fireredasr2"

    def __init__(
        self,
        model_name: str | None = None,
        model_dir: str | None = None,
        device: str | None = None,
        asr_type: str | None = None,
        beam_size: int | None = None,
        batch_size: int | None = None,
        return_timestamp: bool | None = None,
        use_half: bool | None = None,
        src_path: str | None = None,
        **extra: Any,
    ) -> None:
        self._model_name = model_name or settings.default_fireredasr2_model
        self._model_dir = Path(model_dir or settings.fireredasr2_model_path(self._model_name))
        self._device = device or settings.default_fireredasr2_device
        self._asr_type = asr_type or settings.fireredasr2_asr_type
        self._beam_size = beam_size or settings.fireredasr2_beam_size
        self._batch_size = batch_size or settings.fireredasr2_batch_size
        self._return_timestamp = (
            settings.fireredasr2_return_timestamp
            if return_timestamp is None
            else return_timestamp
        )
        self._use_half = settings.fireredasr2_use_half if use_half is None else use_half
        self._src_path = Path(
            src_path
            or settings.fireredasr2_src_path
            or Path(__file__).resolve().parent / "FireRedASR2S"
        )
        self._config_extra = extra
        self._model: Any = None

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    async def load(self) -> None:
        if self._model is not None:
            return

        self._validate_model_dir()
        self._ensure_src_path()

        try:
            from fireredasr2s.fireredasr2 import FireRedAsr2, FireRedAsr2Config
        except ImportError as exc:
            raise RuntimeError(
                "FireRedASR2S dependencies are not importable. "
                "Install the torch/firered dependencies and ensure "
                f"FIREREDASR2_SRC_PATH points to {self._src_path}."
            ) from exc

        config_kwargs = {
            "use_gpu": self._device == "cuda",
            "use_half": self._use_half,
            "beam_size": self._beam_size,
            "return_timestamp": self._return_timestamp,
        }
        config_kwargs.update(self._config_extra)
        config = FireRedAsr2Config(**config_kwargs)

        logger.info(
            "Loading FireRedASR2 model '%s' from %s on %s.",
            self._model_name,
            self._model_dir,
            self._device,
        )
        loop = asyncio.get_running_loop()
        self._model = await loop.run_in_executor(
            None,
            lambda: FireRedAsr2.from_pretrained(
                self._asr_type,
                str(self._model_dir),
                config,
            ),
        )
        logger.info("FireRedASR2 model loaded.")

    async def unload(self) -> None:
        if self._model is not None:
            del self._model
            self._model = None
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
            logger.info("FireRedASR2 model unloaded.")

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
        sample_rate, audio_array = _decode_audio(audio_bytes)

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: self._run_inference(sample_rate, audio_array, opts),
        )

    def _run_inference(
        self,
        sample_rate: int,
        audio_array: np.ndarray,
        opts: EngineOptions,
    ) -> ASRResult:
        assert self._model is not None

        raw_results = self._model.transcribe(["utt0"], [(sample_rate, audio_array)])
        raw = raw_results[0] if raw_results else {"uttid": "utt0", "text": ""}
        text = (raw.get("text") or "").strip()
        confidence = raw.get("confidence")
        duration = raw.get("dur_s")

        segments = _segments_from_raw(raw, text, duration)

        return ASRResult(
            full_text=text,
            segments=segments,
            language=opts.language,
            engine_name=self.name,
            confidence=confidence,
            raw={
                "model_name": self._model_name,
                "asr_type": self._asr_type,
                "result": raw,
            },
        )

    def info(self) -> dict[str, Any]:
        base = super().info()
        base.update(
            {
                "model_name": self._model_name,
                "device": self._device,
                "model_dir": str(self._model_dir),
                "asr_type": self._asr_type,
                "batch_size": self._batch_size,
                "return_timestamp": self._return_timestamp,
                "languages": ["zh", "en"],
            }
        )
        return base

    def _ensure_src_path(self) -> None:
        if not self._src_path.exists():
            raise RuntimeError(f"FireRedASR2S source path not found: {self._src_path}")
        src = str(self._src_path)
        if src not in sys.path:
            sys.path.insert(0, src)

    def _validate_model_dir(self) -> None:
        if not self._model_dir.exists():
            raise RuntimeError(f"FireRedASR2 model directory not found: {self._model_dir}")

        if self._asr_type == "aed":
            required = ("model.pth.tar", "cmvn.ark", "dict.txt", "train_bpe1000.model")
        else:
            required = ("model.pth.tar", "asr_encoder.pth.tar", "cmvn.ark", "Qwen2-7B-Instruct")

        missing = [name for name in required if not (self._model_dir / name).exists()]
        if missing:
            raise RuntimeError(
                "FireRedASR2 model directory is incomplete: "
                f"{self._model_dir}. Missing: {', '.join(missing)}"
            )


def _decode_audio(audio_bytes: bytes) -> tuple[int, np.ndarray]:
    """Decode to 16 kHz mono int16 waveform for FireRedASR2S."""
    try:
        audio, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)
    except Exception:
        return _decode_audio_ffmpeg(audio_bytes)

    if audio.size == 0:
        logger.warning("soundfile decoded zero samples; falling back to ffmpeg.")
        return _decode_audio_ffmpeg(audio_bytes)

    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    if sr != _SAMPLE_RATE:
        import librosa  # type: ignore[import]

        audio = librosa.resample(audio, orig_sr=sr, target_sr=_SAMPLE_RATE)
        sr = _SAMPLE_RATE

    if np.issubdtype(audio.dtype, np.floating):
        audio = np.clip(audio, -1.0, 1.0)
        audio = (audio * 32767.0).astype(np.int16)
    else:
        audio = audio.astype(np.int16, copy=False)

    return sr, np.ascontiguousarray(audio)


def _decode_audio_ffmpeg(audio_bytes: bytes) -> tuple[int, np.ndarray]:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError(
            "ffmpeg is required to decode this audio format, but it was not found in PATH."
        )

    # MP4/M4A containers may require a seekable input. A temporary file keeps
    # uploads format-agnostic while still returning an in-memory waveform.
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
        raise RuntimeError(f"ffmpeg could not decode audio: {stderr}")
    audio = np.frombuffer(proc.stdout, dtype=np.int16)
    if audio.size == 0:
        raise RuntimeError("ffmpeg decoded zero audio samples.")
    return _SAMPLE_RATE, np.ascontiguousarray(audio)


def _segments_from_raw(
    raw: dict[str, Any],
    text: str,
    duration: float | None,
) -> list[Segment]:
    timestamp = raw.get("timestamp")
    if timestamp:
        return [
            Segment(
                start=float(start),
                end=float(end),
                text=str(token),
                confidence=raw.get("confidence"),
            )
            for token, start, end in timestamp
            if str(token).strip()
        ]

    if text:
        end = float(duration) if duration is not None else 0.0
        return [Segment(start=0.0, end=end, text=text, confidence=raw.get("confidence"))]

    return []
