"""
app/core/asr/engines/vosk.py
─────────────────────────────
Vosk offline ASR engine.

Vosk models: https://alphacephei.com/vosk/models
Recommended Chinese model : vosk-model-cn-0.22   (~1.5 GB)
Recommended English model : vosk-model-en-us-0.22 (~1.8 GB)

Vosk operates on raw PCM (16 kHz, 16-bit, mono).
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import struct
import wave
from typing import Any

import numpy as np

from app.config import get_settings
from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions, Segment

logger = logging.getLogger(__name__)
settings = get_settings()

_SAMPLE_RATE = 16_000
_CHANNELS = 1
_SAMPLE_WIDTH = 2  # 16-bit


class VoskEngine(BaseASREngine):
    """
    Vosk-based offline engine.

    Vosk is purely CPU-based, making it suitable for low-resource environments
    where a GPU is unavailable.  It is especially good for streaming (which we
    reserve for a future release) because it processes audio incrementally.
    """

    ENGINE_NAME = "vosk"

    def __init__(
        self,
        model_name: str | None = None,
        model_dir: str | None = None,
    ) -> None:
        self._model_name = model_name or settings.default_vosk_model
        self._model_dir = model_dir or str(settings.vosk_model_path(self._model_name))
        self._model: Any = None      # vosk.Model
        self._sample_rate = _SAMPLE_RATE

    # ── Identity ──────────────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def load(self) -> None:
        if self._model is not None:
            return

        try:
            import vosk  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError(
                "vosk is not installed.  Run: pip install 'asr-backend[vosk]'"
            ) from exc

        from pathlib import Path
        if not Path(self._model_dir).exists():
            raise RuntimeError(
                f"Vosk model directory not found: {self._model_dir}\n"
                "Download from https://alphacephei.com/vosk/models and place in "
                f"models/vosk/{self._model_name}/"
            )

        logger.info("Loading Vosk model from %s …", self._model_dir)
        # vosk.Model loading is CPU-bound
        loop = asyncio.get_running_loop()
        vosk.SetLogLevel(-1)  # suppress verbose Kaldi logging
        self._model = await loop.run_in_executor(
            None, lambda: vosk.Model(self._model_dir)
        )
        logger.info("Vosk model loaded.")

    async def unload(self) -> None:
        if self._model is not None:
            del self._model
            self._model = None
            logger.info("Vosk model unloaded.")

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    # ── Inference ─────────────────────────────────────────────────────────────

    async def transcribe(
        self,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        if not self.is_loaded:
            await self.load()

        # Convert to 16 kHz mono PCM WAV (what Vosk expects)
        pcm_bytes = _to_pcm_wav(audio_bytes)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None, lambda: self._run_inference(pcm_bytes)
        )
        return result

    def _run_inference(self, pcm_wav_bytes: bytes) -> ASRResult:
        import vosk  # type: ignore[import]

        assert self._model is not None
        rec = vosk.KaldiRecognizer(self._model, self._sample_rate)
        rec.SetWords(True)           # include per-word confidence + timing
        rec.SetPartialWords(False)

        # Feed audio in chunks so Kaldi can process it incrementally
        CHUNK = 4000  # bytes ~= 125 ms at 16 kHz 16-bit mono
        with io.BytesIO(pcm_wav_bytes) as buf:
            with wave.open(buf) as wf:
                while True:
                    data = wf.readframes(CHUNK // _SAMPLE_WIDTH)
                    if not data:
                        break
                    rec.AcceptWaveform(data)

        final_json = json.loads(rec.FinalResult())
        return self._parse_result(final_json)

    @staticmethod
    def _parse_result(result_json: dict[str, Any]) -> ASRResult:
        """
        Vosk FinalResult JSON:
        {
          "result": [
            {"conf": 0.96, "end": 1.32, "start": 0.0, "word": "你好"},
            ...
          ],
          "text": "你好 世界"
        }
        """
        full_text = result_json.get("text", "").strip()
        words: list[dict[str, Any]] = result_json.get("result", [])

        # Group consecutive words into segments (split on >0.5 s silence gaps)
        segments: list[Segment] = []
        confidences: list[float] = []

        if words:
            seg_words: list[dict] = [words[0]]
            for w in words[1:]:
                gap = w["start"] - seg_words[-1]["end"]
                if gap > 0.5:
                    segments.append(_words_to_segment(seg_words))
                    seg_words = [w]
                else:
                    seg_words.append(w)
            segments.append(_words_to_segment(seg_words))
            confidences = [w.get("conf", 0.0) for w in words]

        avg_conf = (
            round(sum(confidences) / len(confidences), 4) if confidences else None
        )

        return ASRResult(
            full_text=full_text,
            segments=segments,
            language=None,    # Vosk models are language-specific; no detection
            engine_name="vosk",
            confidence=avg_conf,
            raw={"vosk_result": result_json},
        )

    # ── Metadata ──────────────────────────────────────────────────────────────

    def info(self) -> dict[str, Any]:
        base = super().info()
        base.update({"model_name": self._model_name, "device": "cpu"})
        return base


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_pcm_wav(audio_bytes: bytes) -> bytes:
    """
    Convert arbitrary audio (mp3, m4a, wav, …) to 16 kHz 16-bit mono WAV.
    Returns raw WAV bytes with header.
    """
    import librosa  # type: ignore[import]
    import soundfile as sf  # type: ignore[import]

    buf = io.BytesIO(audio_bytes)
    audio, sr = sf.read(buf, dtype="float32", always_2d=True)

    # Mono mix-down
    if audio.ndim == 2 and audio.shape[1] > 1:
        audio = audio.mean(axis=1)
    else:
        audio = audio.squeeze()

    # Resample
    if sr != _SAMPLE_RATE:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=_SAMPLE_RATE)

    # Convert float32 → int16 PCM
    pcm = (audio * 32767).astype(np.int16)

    # Write WAV into memory
    out = io.BytesIO()
    with wave.open(out, "wb") as wf:
        wf.setnchannels(_CHANNELS)
        wf.setsampwidth(_SAMPLE_WIDTH)
        wf.setframerate(_SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())
    return out.getvalue()


def _words_to_segment(words: list[dict[str, Any]]) -> Segment:
    text = " ".join(w["word"] for w in words)
    conf_vals = [w.get("conf", 0.0) for w in words]
    avg_conf = round(sum(conf_vals) / len(conf_vals), 4) if conf_vals else None
    return Segment(
        start=round(words[0]["start"], 3),
        end=round(words[-1]["end"], 3),
        text=text,
        confidence=avg_conf,
    )