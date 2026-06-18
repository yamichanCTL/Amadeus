"""
VoxCPM2 TTS provider — tokenizer-free multilingual TTS with voice cloning.

Based on OpenBMB/VoxCPM2 (2B params, 48kHz, Apache 2.0).
Supports: voice design (text description), voice cloning (reference audio),
and ultimate cloning (reference + transcript).

Separate from GPT-SoVITS — both can coexist as TTS engines.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from runner.tts.base import TTSProvider, TTSRequest, TTSResult

logger = logging.getLogger("runner.tts.voxcpm")

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_OUTPUT_DIR = _PROJECT_ROOT / ".runtime" / "tts_output"
_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Lazy-loaded global model (GPU memory heavy — load once)
_model: object | None = None


def _get_model():
    """Lazy-load VoxCPM2 model (singleton, GPU)."""
    global _model
    if _model is not None:
        return _model
    try:
        from voxcpm import VoxCPM

        logger.info("Loading VoxCPM2 from openbmb/VoxCPM2...")
        _model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
        logger.info("VoxCPM2 loaded (device=%s)", _model.tts_model.device)
        return _model
    except ImportError:
        logger.error("voxcpm not installed. Run: pip install voxcpm")
        return None
    except Exception as e:
        logger.error("Failed to load VoxCPM2: %s", e)
        return None


class VoxCPMProvider(TTSProvider):
    """VoxCPM2 TTS — voice design + cloning, 30 languages, 48kHz.

    Usage::

        tts = VoxCPMProvider()
        # Voice design (no reference needed)
        result = tts.synthesize(TTSRequest(text="你好世界"))
        # Voice cloning
        result = tts.synthesize(TTSRequest(
            text="你好世界",
            voice="/path/to/reference.wav",
        ))
    """

    name = "voxcpm2"

    def __init__(
        self,
        ref_audio: str | None = None,
        prompt_text: str = "",
        style_desc: str = "",  # e.g. "A young woman, gentle and sweet voice"
    ):
        self.ref_audio = ref_audio
        self.prompt_text = prompt_text
        self.style_desc = style_desc
        self._ready = False

    def _ensure_ready(self) -> bool:
        if self._ready:
            return True
        model = _get_model()
        if model is None:
            return False
        self._ready = True
        return True

    def synthesize(self, request: TTSRequest) -> TTSResult:
        """Generate speech.

        If request.voice is set and points to a valid audio file, uses voice cloning.
        Otherwise, uses voice design with the configured style description.
        """
        if not self._ensure_ready():
            return TTSResult(
                text=request.text,
                provider=self.name,
                success=False,
                error="VoxCPM2 model not loaded",
            )

        model = _get_model()
        if model is None:
            return TTSResult(text=request.text, provider=self.name, success=False,
                             error="Model unavailable")

        text = request.text[:1000]
        speed = request.speed or 1.0
        ref_path = request.voice if request.voice != "default" else self.ref_audio

        # Build prompt with optional style description
        prompt = text
        style = self.style_desc
        if style:
            prompt = f"({style}){text}"

        try:
            t0 = time.perf_counter()

            # Voice cloning mode (reference audio provided)
            if ref_path and Path(ref_path).exists():
                kwargs = {
                    "text": prompt,
                    "reference_wav_path": ref_path,
                }
                if self.prompt_text:
                    kwargs["prompt_text"] = self.prompt_text
                    kwargs["prompt_wav_path"] = ref_path
            else:
                # Voice design mode (no reference)
                kwargs = {"text": prompt}

            import torch
            with torch.no_grad():
                wav = model.generate(**kwargs)

            t1 = time.perf_counter()
            duration = round(t1 - t0, 3)
            sample_rate = model.tts_model.sample_rate  # 48000
            audio_dur = len(wav) / sample_rate

            try:
                import soundfile as sf
            except ImportError:
                import scipy.io.wavfile as wavfile
                ts = int(time.time() * 1000)
                path = _OUTPUT_DIR / f"voxcpm_{ts}.wav"
                wavfile.write(str(path), sample_rate, wav)
            else:
                ts = int(time.time() * 1000)
                path = _OUTPUT_DIR / f"voxcpm_{ts}.wav"
                sf.write(str(path), wav, sample_rate)

            mode = "clone" if (ref_path and Path(ref_path).exists()) else "design"
            logger.info("VoxCPM2[%s]: %.2fs → %s (%.1fs audio)", mode, duration, path.name, audio_dur)

            return TTSResult(
                text=text,
                audio_path=str(path),
                duration_seconds=audio_dur,
                provider=self.name,
                success=True,
            )
        except Exception as e:
            logger.error("VoxCPM2 synthesis failed: %s", e)
            return TTSResult(
                text=text,
                provider=self.name,
                success=False,
                error=str(e),
            )
