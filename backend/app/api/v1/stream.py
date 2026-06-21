"""WebSocket endpoint for native streaming ASR."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.model_errors import ModelRuntimeError, classify_model_error
from app.core.streaming.session import StreamingASRSession, parse_stream_config

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/stream", tags=["streaming"])


@router.websocket("")
async def stream_asr(websocket: WebSocket) -> None:
    """
    Stream 16 kHz mono PCM over WebSocket.

    Client text frames:
    - ``{"type":"config","engine":"x-asr","language":"zh","user_id":"u1"}``
    - ``{"type":"audio","data":"<base64 pcm_s16le>"}``
    - ``{"type":"end"}``

    Client binary frames are treated as raw ``pcm_s16le`` audio chunks.
    """

    await websocket.accept()
    # Send an immediate "accepted" frame so the client knows the WebSocket
    # handshake succeeded, even when downstream initialisation (VAD model
    # load, X-ASR engine warm-up) takes several seconds on first connect.
    await websocket.send_text(json.dumps({"type": "accepted"}, ensure_ascii=False))

    # FireRed VAD construction loads model state and can take longer than the
    # browser's connection timeout on the first stream. Keep that synchronous
    # work off the event loop so the accepted WebSocket handshake is flushed.
    await asyncio.sleep(0)

    # If init takes > 3 s, send periodic "loading" heartbeats so the client
    # doesn't think the connection has stalled.
    init_started = asyncio.get_event_loop().time()
    session_future = asyncio.ensure_future(asyncio.to_thread(StreamingASRSession))

    async def _loading_heartbeat() -> None:
        while not session_future.done():
            elapsed = asyncio.get_event_loop().time() - init_started
            if elapsed >= 3.0:
                await websocket.send_text(
                    json.dumps(
                        {"type": "loading", "message": "正在加载语音识别模型…", "elapsed_s": round(elapsed, 1)},
                        ensure_ascii=False,
                    )
                )
            await asyncio.sleep(2.0)

    heartbeat_task = asyncio.create_task(_loading_heartbeat())
    try:
        session = await session_future
    except ModelRuntimeError as exc:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        failure = classify_model_error(exc, "x-asr")
        logger.exception("Could not initialise streaming ASR model: %s", failure.detail)
        await websocket.send_text(json.dumps(failure.as_event(), ensure_ascii=False))
        await websocket.close(code=1011)
        return
    except Exception as exc:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        logger.exception("Could not initialise streaming ASR session: %s", exc)
        await websocket.send_text(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False))
        await websocket.close(code=1011)
        return
    finally:
        if not heartbeat_task.done():
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass

    await session.send_ready()
    sender = asyncio.create_task(_send_loop(websocket, session))
    logger.info("WebSocket stream connected from %s", websocket.client)

    failed = False
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
    except ModelRuntimeError as exc:
        failed = True
        logger.exception("Streaming ASR model failed: %s", exc.detail)
        await session.record_model_failure(exc)
    except Exception as exc:
        failed = True
        logger.exception("Streaming session failed: %s", exc)
        await session.queue.put(
            {
                "type": "error",
                "code": "stream_failed",
                "session_id": session.session_id,
                "message": str(exc),
                "fatal": True,
            }
        )
    finally:
        if failed or session.fatal_error is not None:
            await session.abort()
        else:
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
                "type": "loading",
                "session_id": session.session_id,
                "message": "正在预热流式 VAD 与 ASR 模型",
                "state": session.state,
            }
        )
        await session.prepare()
        await session.queue.put(
            {
                "type": "configured",
                "session_id": session.session_id,
                "engine": session.config.engine,
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
        try:
            await websocket.send_text(json.dumps(event, ensure_ascii=False))
        except (WebSocketDisconnect, RuntimeError):
            return
        if event.get("type") == "error" and event.get("fatal"):
            try:
                await websocket.close(code=1011)
            except (WebSocketDisconnect, RuntimeError):
                pass
            return
        if event.get("type") == "done":
            return
