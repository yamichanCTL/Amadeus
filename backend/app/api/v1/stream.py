"""WebSocket endpoint for VAD-driven pseudo-streaming ASR."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.streaming.session import StreamingASRSession, parse_stream_config

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/stream", tags=["streaming"])


@router.websocket("")
async def stream_asr(websocket: WebSocket) -> None:
    """
    Stream 16 kHz mono PCM over WebSocket.

    Client text frames:
    - ``{"type":"config","engine":"sensevoice","language":"zh","user_id":"u1"}``
    - ``{"type":"audio","data":"<base64 pcm_s16le>"}``
    - ``{"type":"end"}``

    Client binary frames are treated as raw ``pcm_s16le`` audio chunks.
    """

    await websocket.accept()
    session = StreamingASRSession()
    await session.send_ready()
    sender = asyncio.create_task(_send_loop(websocket, session))
    logger.info("WebSocket stream connected from %s", websocket.client)

    try:
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                await session.accept_audio(message["bytes"] or b"")
                continue
            if message.get("text") is not None:
                should_close = await _handle_text_frame(session, message["text"])
                if should_close:
                    break
            if message.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("Streaming session failed: %s", exc)
        await session.queue.put({"type": "error", "session_id": session.session_id, "message": str(exc)})
    finally:
        await session.finish()
        await sender
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info("WebSocket stream closed.")


async def _handle_text_frame(session: StreamingASRSession, text: str) -> bool:
    data = parse_stream_config(text)
    msg_type = data.get("type")
    if msg_type == "config":
        session.update_config(data)
        await session.queue.put(
            {
                "type": "configured",
                "session_id": session.session_id,
                "engine": session.config.engine,
                "final_engine": session.config.final_engine,
                "language": session.config.language,
                "user_id": session.config.user_id,
                "category": session.config.category,
                "state": session.state,
            }
        )
        return False
    if msg_type == "audio":
        payload = data.get("data")
        if not isinstance(payload, str):
            raise ValueError("audio text frames require base64 string field 'data'")
        await session.accept_audio(base64.b64decode(payload))
        return False
    if msg_type == "end":
        return True
    if msg_type == "ping":
        await session.queue.put({"type": "pong", "session_id": session.session_id, "state": session.state})
        return False
    raise ValueError(f"Unknown stream message type: {msg_type}")


async def _send_loop(websocket: WebSocket, session: StreamingASRSession) -> None:
    while True:
        event: dict[str, Any] = await session.queue.get()
        await websocket.send_text(json.dumps(event, ensure_ascii=False))
        if event.get("type") == "done":
            return
