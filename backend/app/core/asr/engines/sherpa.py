"""
app/core/asr/engines/sherpa.py
────────────────────────────────
Sherpa-onnx offline ASR engine.

Sherpa-onnx supports a wide range of models exported to ONNX format and runs
without requiring PyTorch or CUDA, making it the lightest engine option.

Typical model layout under models/sherpa/<model_name>/:
  encoder-epoch-99-avg-1.onnx
  decoder-epoch-99-avg-1.onnx
  joiner-epoch-99-avg-1.onnx
  tokens.txt
  (+ bpe.model for BPE tokenisers)

Reference: https://github.com/k2-fsa/sherpa-onnx
"""

from __future__ import annotations

import asyncio
import io
import logging
from pathlib import Path
from typing import Any

import numpy as np

from app.config import get_settings
from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions, Segment

logger = logging.getLogger(__name__)
settings = get_settings()

_SAMPLE_RATE = 16_000


class SherpaEngine(BaseASREngine):
    """
    Sherpa-onnx offline transducer/CTC engine.

    Automatically detects the model architecture (transducer vs CTC) by
    inspecting the model directory contents.
    """

    ENGINE_NAME = "sherpa"

    def __init__(
        self,
        model_name: str | None = None,
        model_dir: str | None = None,
    ) -> None:
        self._model_name = model_name or settings.default_sherpa_model
        self._model_dir = Path(
            model_dir or settings.sherpa_model_path(self._model_name)
        )
        self._recognizer: Any = None   # sherpa_onnx.OfflineRecognizer

    # ── Identity ──────────────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def load(self) -> None:
        if self._recognizer is not None:
            return

        try:
            import sherpa_onnx  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError(
                "sherpa-onnx is not installed.  "
                "Run: pip install 'asr-backend[sherpa]'"
            ) from exc

        if not self._model_dir.exists():
            raise RuntimeError(
                f"Sherpa-onnx model directory not found: {self._model_dir}\n"
                "Download a model from https://github.com/k2-fsa/sherpa-onnx/releases"
            )

        logger.info("Loading Sherpa-onnx model from %s …", self._model_dir)
        config = self._build_config(sherpa_onnx)

        loop = asyncio.get_running_loop()
        self._recognizer = await loop.run_in_executor(
            None,
            lambda: sherpa_onnx.OfflineRecognizer(config),
        )
        logger.info("Sherpa-onnx model loaded.")

    def _build_config(self, sherpa_onnx: Any) -> Any:
        """
        Detect model architecture and return the appropriate config object.
        Priority: transducer > CTC > paraformer.
        """
        d = self._model_dir
        tokens = str(d / "tokens.txt")

        # ── Transducer (encoder + decoder + joiner) ────────────────────────
        encoder_files = list(d.glob("encoder*.onnx"))
        decoder_files = list(d.glob("decoder*.onnx"))
        joiner_files  = list(d.glob("joiner*.onnx"))

        if encoder_files and decoder_files and joiner_files:
            model_cfg = sherpa_onnx.OfflineTransducerModelConfig(
                encoder=str(encoder_files[0]),
                decoder=str(decoder_files[0]),
                joiner=str(joiner_files[0]),
            )
            return sherpa_onnx.OfflineRecognizerConfig(
                model=sherpa_onnx.OfflineModelConfig(
                    transducer=model_cfg,
                    tokens=tokens,
                    num_threads=4,
                ),
                decoding_method="greedy_search",
            )

        # ── CTC ────────────────────────────────────────────────────────────
        ctc_files = list(d.glob("*.onnx"))
        if ctc_files:
            model_cfg = sherpa_onnx.OfflineCTCModelConfig(
                model=str(ctc_files[0]),
            )
            return sherpa_onnx.OfflineRecognizerConfig(
                model=sherpa_onnx.OfflineModelConfig(
                    ctc=model_cfg,
                    tokens=tokens,
                    num_threads=4,
                ),
                decoding_method="ctc_greedy_search",
            )

        raise RuntimeError(
            f"Cannot detect Sherpa-onnx model architecture in {self._model_dir}. "
            "Expected encoder/decoder/joiner ONNX files (transducer) or a single "
            "*.onnx file (CTC)."
        )

    async def unload(self) -> None:
        if self._recognizer is not None:
            del self._recognizer
            self._recognizer = None
            logger.info("Sherpa-onnx model unloaded.")

    @property
    def is_loaded(self) -> bool:
        return self._recognizer is not None

    # ── Inference ─────────────────────────────────────────────────────────────

    async def transcribe(
        self,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        if not self.is_loaded:
            await self.load()

        audio_array = _decode_audio(audio_bytes)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: self._run_inference(audio_array),
        )
        return result

    def _run_inference(self, audio_array: np.ndarray) -> ASRResult:
        import sherpa_onnx  # type: ignore[import]

        assert self._recognizer is not None

        stream = self._recognizer.create_stream()
        stream.accept_waveform(_SAMPLE_RATE, audio_array)
        self._recognizer.decode_stream(stream)

        result = stream.result
        text = result.text.strip()

        # Sherpa-onnx returns token-level timestamps when the model supports it
        segments: list[Segment] = []
        if hasattr(result, "timestamps") and result.timestamps:
            # Group tokens into word-level segments
            segments = _tokens_to_segments(result.tokens, result.timestamps)

        return ASRResult(
            full_text=text,
            segments=segments,
            language=None,   # Sherpa models are language-specific
            engine_name=self.name,
            confidence=None,  # Sherpa greedy search does not expose confidence
            raw={"text": text},
        )

    # ── Metadata ──────────────────────────────────────────────────────────────

    def info(self) -> dict[str, Any]:
        base = super().info()
        base.update(
            {
                "model_name": self._model_name,
                "device": "cpu",
                "model_dir": str(self._model_dir),
            }
        )
        return base


# ── Helpers ───────────────────────────────────────────────────────────────────

def _decode_audio(audio_bytes: bytes) -> np.ndarray:
    """Decode to float32 mono array at 16 kHz."""
    import soundfile as sf  # type: ignore[import]

    buf = io.BytesIO(audio_bytes)
    audio, sr = sf.read(buf, dtype="float32", always_2d=True)

    if audio.ndim == 2 and audio.shape[1] > 1:
        audio = audio.mean(axis=1)
    else:
        audio = audio.squeeze()

    if sr != _SAMPLE_RATE:
        import librosa  # type: ignore[import]
        audio = librosa.resample(audio, orig_sr=sr, target_sr=_SAMPLE_RATE)

    return audio.astype(np.float32)


def _tokens_to_segments(
    tokens: list[str], timestamps: list[float]
) -> list[Segment]:
    """
    Group character/subword tokens into rough word-level segments.
    For CJK we treat each character as its own 'word'.
    """
    if not tokens:
        return []

    segments: list[Segment] = []
    current: list[str] = []
    start_t: float = timestamps[0]

    for token, t in zip(tokens, timestamps):
        current.append(token)
        # New segment on space, punctuation gap, or CJK character boundary
        if token in (" ", "▁") or _is_cjk(token):
            word = "".join(current).strip()
            if word:
                segments.append(Segment(start=round(start_t, 3), end=round(t, 3), text=word))
            current = []
            start_t = t

    # Flush remainder
    if current:
        word = "".join(current).strip()
        if word:
            segments.append(
                Segment(start=round(start_t, 3), end=round(timestamps[-1], 3), text=word)
            )

    return segments


def _is_cjk(char: str) -> bool:
    """Return True if the character is a CJK ideograph."""
    if not char:
        return False
    cp = ord(char[0])
    return (
        0x4E00 <= cp <= 0x9FFF
        or 0x3400 <= cp <= 0x4DBF
        or 0xF900 <= cp <= 0xFAFF
    )