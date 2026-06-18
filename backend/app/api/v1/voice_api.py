"""
Voice conversion API — WAV in, WAV out with selectable target voice.

POST /v1/voice/convert  — Upload WAV, select voice, get converted WAV
GET  /v1/voice/voices   — List available voice presets
"""

from __future__ import annotations

import logging
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response

logger = logging.getLogger(__name__)

_RUNNER_ROOT = Path(__file__).resolve().parents[4]
if str(_RUNNER_ROOT) not in sys.path:
    sys.path.insert(0, str(_RUNNER_ROOT))

router = APIRouter(prefix="/voice", tags=["voice"])


@router.get("/voices", summary="List available voice presets")
async def list_voices():
    """Return all available target voices for conversion."""
    from runner.voice.converter import list_voices

    voices = list_voices()
    return {
        "voices": [
            {
                "id": v.id,
                "name": v.name,
                "description": v.description,
                "prompt_lang": v.prompt_lang,
            }
            for v in voices
        ]
    }


@router.post("/convert", summary="Convert voice: WAV in → WAV out")
async def convert_voice(
    audio: UploadFile = File(..., description="Input WAV audio file"),
    voice_id: str = Form(default="elysia", description="Target voice preset ID"),
    speed: float = Form(default=1.0, ge=0.5, le=2.0, description="Speech speed"),
):
    """Upload a WAV file, convert to the selected target voice.

    Returns the converted WAV audio file directly.
    """
    suffix = Path(audio.filename or "input.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        input_path = tmp.name

    try:
        from runner.voice.converter import VoiceConverter

        conv = VoiceConverter()
        result = conv.convert(input_path, voice_id=voice_id, speed=speed)

        if not result.success:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=result.error,
            )

        audio_bytes = Path(result.output_path).read_bytes()
        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": f"inline; filename=converted_{voice_id}.wav",
                "X-Input-Len": str(len(result.input_text)) if result.input_text else "0",
                "X-Voice-Name": result.voice_name,
                "X-ASR-Duration": str(result.asr_duration),
                "X-TTS-Duration": str(result.tts_duration),
                "X-Total-Duration": str(result.total_duration),
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Voice conversion failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Conversion failed: {e}",
        ) from e
    finally:
        Path(input_path).unlink(missing_ok=True)
