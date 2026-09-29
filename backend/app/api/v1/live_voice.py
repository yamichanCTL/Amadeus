"""Local realtime voice configuration, native streams, and GPT Live SDP exchange."""

from __future__ import annotations

import asyncio
import json
from urllib.parse import urlsplit

import httpx
from app.config import get_settings
from app.core.live_voice.configuration import catalog, local_config, save_config
from app.core.live_voice.session import run_session, validate_start
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketState
from websockets.exceptions import ConnectionClosed

router = APIRouter(prefix="/live-voice", tags=["live-voice"])


class LiveOffer(BaseModel):
    provider: str = Field(pattern="^(openai|qwen)$")
    sdp: str = Field(min_length=16, max_length=131072)
    instructions: str = Field(default="", max_length=4000)


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _trusted_local(request: Request | WebSocket) -> bool:
    if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
        return False
    try:
        host = urlsplit("http://" + request.headers.get("host", "")).hostname
        if host not in LOCAL_HOSTS:
            return False
        origin = request.headers.get("origin")
        if origin is None:
            return True
        parsed = urlsplit(origin)
        return ((parsed.scheme in {"http", "https"} and parsed.hostname in LOCAL_HOSTS)
                or parsed.scheme in {"file", "app"})
    except ValueError:
        return False


def _local_only(request: Request) -> None:
    if not _trusted_local(request):
        raise HTTPException(403, "实时语音配置和会话仅允许本机应用访问")


@router.get("/providers")
async def providers(request: Request) -> dict:
    _local_only(request)
    current = catalog()
    return {row["id"]: {"configured": row["configured"], "available": row["available"],
                        "model": row["model"], "region": current["config"]["dashscope_region"]}
            for row in current["providers"]}


@router.get("/catalog")
async def provider_catalog(request: Request) -> dict:
    _local_only(request)
    return catalog()


@router.put("/config")
async def update_config(request: Request) -> dict:
    _local_only(request)
    if request.headers.get("x-amadeus-config") != "1":
        raise HTTPException(403, "配置更新缺少本机应用标识")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 16_384:
            raise HTTPException(413, "实时语音配置过大")
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        raise HTTPException(422, "配置必须是 JSON 对象") from None
    try:
        save_config(payload)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    except OSError:
        raise HTTPException(500, "本机配置保存失败，请检查 backend/.env 的写入权限") from None
    return catalog()


@router.websocket("/ws")
async def voice_stream(websocket: WebSocket) -> None:
    if not _trusted_local(websocket):
        await websocket.close(code=1008, reason="Local application only")
        return
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=15)
        if len(raw) > 16_384:
            await websocket.close(code=1009, reason="Start too large")
            return
        values = local_config()
        try:
            payload = json.loads(raw)
        except ValueError:
            await websocket.send_json({"type": "error", "message": "会话配置 JSON 无效"})
            return
        try:
            start = validate_start(payload, values)
        except ValueError as error:
            await websocket.send_json({"type": "error", "message": str(error)})
            return
        await run_session(websocket, values, start)
    except (WebSocketDisconnect, ConnectionClosed):
        pass
    except (TimeoutError, asyncio.TimeoutError):
        await _stream_error(websocket, "实时语音连接超时，请检查网络后重新连接")
    except Exception:
        # Never reflect exception text: Gemini connection URLs contain an API key.
        await _stream_error(websocket, "实时语音连接失败，请检查模型配置、可用额度和本机网络")
    finally:
        if websocket.application_state != WebSocketState.DISCONNECTED:
            try:
                await websocket.close(code=1000)
            except (RuntimeError, WebSocketDisconnect):
                pass


async def _stream_error(websocket: WebSocket, message: str) -> None:
    try:
        await websocket.send_json({"type": "error", "message": message})
    except (RuntimeError, WebSocketDisconnect):
        pass


@router.post("/session")
async def create_session(request: Request, offer: LiveOffer) -> dict:
    _local_only(request)
    if offer.provider == "qwen":
        raise HTTPException(409, "千问 Audio 3.1 已迁移至 /v1/live-voice/ws，请使用实时语音 WebSocket 通道")
    if not offer.sdp.startswith("v=0"):
        raise HTTPException(422, "无效的 WebRTC SDP offer")
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            if offer.provider == "openai":
                if not settings.openai_api_key:
                    raise HTTPException(503, "未配置 OPENAI_API_KEY；尚未创建付费会话")
                response = await client.post(
                    "https://api.openai.com/v1/live/sessions",
                    headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                    json={
                        "session": {
                            "model": "gpt-live-1",
                            "instructions": offer.instructions or "你是爱弥斯，桌面数字人。自然、简短地实时交谈。需要深入推理或执行任务时委派给后台，并在等待期间继续与用户交流。",
                            "delegation": {"type": "client"},
                        },
                        "transport": {"type": "webrtc", "sdp": offer.sdp},
                    },
                )
                response.raise_for_status()
                payload = response.json()
                return {"provider": "openai", "session_id": payload["session"]["id"], "sdp": payload["transport"]["sdp"]}

    except httpx.HTTPStatusError as error:
        raise HTTPException(502, f"{offer.provider} 实时语音建连失败（上游 HTTP {error.response.status_code}）") from None
    except httpx.RequestError:
        raise HTTPException(502, f"{offer.provider} 实时语音服务连接失败") from None
