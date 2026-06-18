"""
VoiceConverter — WAV in, WAV out with selectable target voice.

Preset voices are defined with their reference audio and prompt text.
Custom voices can be added at runtime.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from runner.asr.whisper_adapter import WhisperASR

logger = logging.getLogger("runner.voice")

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_OUTPUT_DIR = _PROJECT_ROOT / ".runtime" / "voice_output"
_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class VoicePreset:
    """A preset voice for voice conversion.

    Attributes:
        id: Unique voice identifier.
        name: Display name.
        ref_audio: Path to reference audio for voice cloning.
        prompt_text: Text content of the reference audio (empty = auto-detect).
        prompt_lang: Language of the reference audio.
        description: Human-readable description.
    """

    id: str
    name: str
    ref_audio: str
    prompt_text: str = ""
    prompt_lang: str = "zh"
    description: str = ""


# ── Built-in voice presets ───────────────────────────────────────────────────

_VOICES: dict[str, VoicePreset] = {
    "elysia": VoicePreset(
        id="elysia",
        name="Elysia",
        ref_audio=str(_PROJECT_ROOT / ".runtime" / "ref_elysia.wav"),
        prompt_text="",
        prompt_lang="zh",
        description="Elysia 语音 — 温柔女声",
    ),
    "original": VoicePreset(
        id="original",
        name="原始录音",
        ref_audio=str(_PROJECT_ROOT / "录音.wav"),
        prompt_text="",
        prompt_lang="ja",
        description="原始录音声纹 (GPT-SoVITS)",
    ),
    "voxcpm_elysia": VoicePreset(
        id="voxcpm_elysia",
        name="VoxCPM2 - Elysia",
        ref_audio=str(_PROJECT_ROOT / ".runtime" / "ref_elysia.wav"),
        prompt_text="",
        prompt_lang="zh",
        description="VoxCPM2 克隆 Elysia 语音 — 48kHz 高保真",
    ),
    "voxcpm_design": VoicePreset(
        id="voxcpm_design",
        name="VoxCPM2 - 温柔女声",
        ref_audio="",  # No reference — voice design mode
        prompt_text="",
        prompt_lang="zh",
        description="VoxCPM2 语音设计 (A young woman, gentle voice) — 无需参考音频",
    ),
}


def list_voices() -> list[VoicePreset]:
    """Return all available voice presets."""
    return list(_VOICES.values())


def get_voice(voice_id: str) -> VoicePreset | None:
    """Get a voice preset by ID."""
    return _VOICES.get(voice_id)


def add_voice(preset: VoicePreset) -> None:
    """Register a custom voice."""
    _VOICES[preset.id] = preset


@dataclass
class ConvertResult:
    """Result of a voice conversion."""

    success: bool
    input_text: str = ""
    output_path: str = ""
    input_duration: float = 0.0
    output_duration: float = 0.0
    asr_duration: float = 0.0
    tts_duration: float = 0.0
    total_duration: float = 0.0
    voice_id: str = ""
    voice_name: str = ""
    error: str = ""


class VoiceConverter:
    """Convert input speech to a different voice.

    Pipeline: input WAV → ASR → text → GPT-SoVITS(target voice) → output WAV

    Usage::

        conv = VoiceConverter()
        result = conv.convert("/path/to/input.wav", voice_id="elysia")
        print(result.output_path)  # Path to converted WAV
    """

    def __init__(self, model_size: str = "base"):
        self.asr = WhisperASR(model_size=model_size)
        self._server_url = "http://127.0.0.1:9880"

    def convert(
        self,
        input_path: str,
        voice_id: str = "elysia",
        speed: float = 1.0,
    ) -> ConvertResult:
        """Convert input audio to target voice.

        Args:
            input_path: Path to input WAV/audio file.
            voice_id: Target voice preset ID (e.g. "elysia", "original").
            speed: Speech speed multiplier.

        Returns:
            ConvertResult with output path and timing info.
        """
        t_start = time.perf_counter()
        input_path_obj = Path(input_path)
        if not input_path_obj.exists():
            return ConvertResult(success=False, error=f"Input file not found: {input_path}")

        voice = get_voice(voice_id)
        if voice is None:
            return ConvertResult(
                success=False,
                error=f"Unknown voice '{voice_id}'. Available: {list(_VOICES.keys())}",
            )

        # Ensure ref audio is WAV
        ref_wav = voice.ref_audio
        if voice.ref_audio and Path(voice.ref_audio).suffix.lower() in (".m4a", ".mp3"):
            ref_wav = str(Path(voice.ref_audio).with_suffix(".wav"))

        # Stage 1: ASR
        t_asr = time.perf_counter()
        asr_result = self.asr.transcribe(input_path)
        text = asr_result.text.strip()
        asr_dur = round(time.perf_counter() - t_asr, 3)

        if not text:
            return ConvertResult(
                success=False, error="No speech detected in input audio",
                asr_duration=asr_dur, voice_id=voice_id, voice_name=voice.name,
            )

        # Stage 2: TTS with target voice
        t_tts = time.perf_counter()
        tts_result = self._tts_with_voice(text, ref_wav, voice, speed)
        tts_dur = round(time.perf_counter() - t_tts, 3)

        total = round(time.perf_counter() - t_start, 3)

        if tts_result is None:
            return ConvertResult(
                success=False, error="TTS synthesis failed",
                input_text=text, asr_duration=asr_dur, tts_duration=tts_dur,
                total_duration=total, voice_id=voice_id, voice_name=voice.name,
            )

        ts = int(time.time() * 1000)
        out_path = _OUTPUT_DIR / f"converted_{voice_id}_{ts}.wav"
        out_path.write_bytes(tts_result)

        logger.info(
            "Voice convert: %s → %s, text=\"%s\", asr=%.2fs tts=%.2fs total=%.2fs",
            input_path_obj.name, voice.name, text[:50], asr_dur, tts_dur, total,
        )

        return ConvertResult(
            success=True,
            input_text=text,
            output_path=str(out_path),
            input_duration=asr_result.duration_seconds,
            output_duration=len(tts_result) / 32000,
            asr_duration=asr_dur,
            tts_duration=tts_dur,
            total_duration=total,
            voice_id=voice_id,
            voice_name=voice.name,
        )

    def _tts_with_voice(
        self, text: str, ref_wav: str, voice: VoicePreset, speed: float,
    ) -> bytes | None:
        """Call GPT-SoVITS TTS with the target voice's reference audio."""
        try:
            resp = httpx.post(
                f"{self._server_url}/tts",
                json={
                    "text": text[:500],
                    "text_lang": voice.prompt_lang,
                    "ref_audio_path": ref_wav if Path(ref_wav).exists() else "",
                    "prompt_lang": voice.prompt_lang,
                    "prompt_text": voice.prompt_text,
                    "text_split_method": "cut0",
                    "batch_size": 1,
                    "speed_factor": speed,
                },
                timeout=120,
            )
            if resp.status_code == 200 and len(resp.content) > 100:
                return resp.content
            return None
        except Exception as e:
            logger.error("TTS failed for voice '%s': %s", voice.id, e)
            return None
