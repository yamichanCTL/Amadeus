"""
app/api/v1/stream.py
─────────────────────
WebSocket endpoint for real-time streaming ASR — reserved.

WS /v1/stream

Protocol (future)
─────────────────
Client  →  Server  :  binary frames of raw PCM audio (16 kHz, 16-bit, mono)
                       OR  text frame {"type": "config", "language": "zh", "engine": "sherpa"}
                       OR  text frame {"type": "end"}   (signal end of audio)

Server  →  Client  :  text frames of JSON:
    {"type": "partial", "text": "识别中 …"}
    {"type": "final",   "text": "完整的句子。", "start": 0.0, "end": 3.2}
    {"type": "error",   "message": "..."}
    {"type": "done"}

Current state
─────────────
The endpoint accepts WebSocket connections, sends a "not implemented" message,
and closes cleanly.  This avoids 404 errors from clients that already probe
the streaming URL.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/stream", tags=["streaming"])


@router.websocket("")
async def stream_asr(websocket: WebSocket) -> None:
    """
    Real-time ASR via WebSocket.

    **Status**: reserved — not yet implemented.

    Connects, notifies the client, then closes with code 1001 (going away).
    """
    await websocket.accept()
    logger.info("WebSocket stream connected from %s", websocket.client)

    try:
        await websocket.send_text(
            json.dumps(
                {
                    "type": "error",
                    "code": "NOT_IMPLEMENTED",
                    "message": (
                        "Streaming ASR is reserved for a future release. "
                        "Use POST /v1/transcribe for offline recognition."
                    ),
                }
            )
        )
    except Exception:
        pass
    finally:
        try:
            await websocket.close(code=1001)
        except Exception:
            pass
        logger.info("WebSocket stream closed.")


# ────────────────────────────────────────────────────────────────────────────
#  Scaffolding for future implementation
#  (kept here so the structure is clear when the time comes)
# ────────────────────────────────────────────────────────────────────────────

async def _handle_stream_session(websocket: WebSocket) -> None:  # pragma: no cover
    """
    Future: full streaming session handler.

    1. Wait for a JSON "config" frame from the client.
    2. Load the streaming-capable engine (Sherpa OnlineRecognizer / Vosk).
    3. Forward incoming binary PCM chunks to the engine.
    4. Send partial and final results back to the client as JSON text frames.
    5. On "end" frame or disconnect: finalise, send "done", close.
    """
    from app.core.model_manager import get_model_manager
    from app.core.asr.base import EngineOptions

    manager = get_model_manager()
    engine_name = "sherpa"   # default streaming engine
    language = None

    # Config frame
    try:
        raw = await websocket.receive_text()
        cfg = json.loads(raw)
        if cfg.get("type") == "config":
            engine_name = cfg.get("engine", engine_name)
            language = cfg.get("language")
    except Exception:
        pass

    engine = await manager.get_engine(engine_name)
    options = EngineOptions(language=language)

    async def _chunk_iter():
        while True:
            try:
                data = await websocket.receive()
                if "bytes" in data:
                    yield data["bytes"]
                elif "text" in data:
                    msg = json.loads(data["text"])
                    if msg.get("type") == "end":
                        return
            except WebSocketDisconnect:
                return

    async for partial_result in engine.transcribe_stream(_chunk_iter(), options):
        await websocket.send_text(
            json.dumps(
                {
                    "type": "final" if partial_result.raw.get("is_final") else "partial",
                    "text": partial_result.full_text,
                }
            )
        )

    await websocket.send_text(json.dumps({"type": "done"}))