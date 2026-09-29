"""Gemini native audio streaming adapter; no separate process is required."""
from __future__ import annotations
import asyncio
import base64
import json
from datetime import datetime
from zoneinfo import ZoneInfo
import websockets

UPSTREAM = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent"
)
MODELS = {
    "live": "gemini-3.8-live",
    "thinking": "gemini-3.8-live-extended-thinking",
}
INSTRUCTION = (
    "你是艾米斯，一个自然、亲切的中文语音助手。回答简洁，可以被用户随时打断。"
    "你当前只能读取本机北京时间；没有屏幕、文件、网络搜索、桌面控制或其他工具。"
    "用户询问当前时间或日期时，必须先调用 get_local_time；没有收到工具结果，不能猜测时间。"
    "没有实际工具调用成功时，不要声称已经看见屏幕、执行操作或查询资料。"
    "若用户请求暂时做不到的事，直接说明目前能力边界。"
)



async def send_json(ws, payload: dict):
    await ws.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def setup_message(model: str, voice: str | None = None, instructions: str = "", reasoning: str = "low") -> dict:
    config = {"responseModalities": ["AUDIO"]}
    if voice:
        config["speechConfig"] = {"voiceConfig": {
            "prebuiltVoiceConfig": {"voiceName": voice},
        }}
    if model == "thinking":
        config["thinkingConfig"] = {"thinkingLevel": reasoning.upper()}
    return {"setup": {
        "model": f"models/{MODELS[model]}",
        "generationConfig": config,
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        "systemInstruction": {"parts": [{"text": instructions or INSTRUCTION}]},
        "tools": [{"functionDeclarations": [{
            "name": "get_local_time",
            "description": "读取当前北京时间。用户询问现在几点、日期或星期时使用。",
            "behavior": "NON_BLOCKING",
            "parameters": {"type": "OBJECT", "properties": {}},
        }]}],
    }}


async def from_browser(local, upstream):
    audio_samples = 0
    async for raw in local:
        if not isinstance(raw, str) or len(raw) > 150_000:
            await send_json(local, {"type": "error", "message": "输入过大"})
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "audio":
            data = event.get("data", "")
            if not isinstance(data, str) or len(data) > 130_000:
                continue
            try:
                pcm = base64.b64decode(data, validate=True)
            except (ValueError, base64.binascii.Error):
                continue
            if not pcm or len(pcm) > 96_000 or len(pcm) % 2:
                continue
            await send_json(upstream, {"realtimeInput": {"audio": {
                "data": data, "mimeType": "audio/pcm;rate=16000",
            }}})
            if not event.get("padding"):
                previous = audio_samples
                audio_samples += len(pcm) // 2
                if audio_samples // 16000 > previous // 16000:
                    await send_json(local, {"type": "capture_ack",
                                            "seconds": round(audio_samples / 16000, 1)})
        elif kind == "audio_end":
            await send_json(upstream, {"realtimeInput": {"audioStreamEnd": True}})
        elif kind == "text":
            value = event.get("text", "")
            if isinstance(value, str) and 0 < len(value.strip()) <= 2000:
                await send_json(upstream, {"clientContent": {"turns": [{
                    "role": "user", "parts": [{"text": value.strip()}],
                }], "turnComplete": True}})


async def from_gemini(local, upstream):
    async for raw in upstream:
        event = json.loads(raw)
        if "error" in event:
            detail = "Gemini 请求失败，请检查模型配置、权限或剩余额度。"
            await send_json(local, {"type": "error", "message": detail})
            continue
        content = event.get("serverContent") or {}
        if content.get("interrupted"):
            await send_json(local, {"type": "interrupted"})
        for key, kind in (("inputTranscription", "input_transcript"),
                          ("outputTranscription", "output_transcript")):
            text = (content.get(key) or {}).get("text")
            if text:
                await send_json(local, {"type": kind, "text": text})
        for part in ((content.get("modelTurn") or {}).get("parts") or []):
            inline = part.get("inlineData") or {}
            if inline.get("mimeType", "").startswith("audio/") and inline.get("data"):
                await send_json(local, {"type": "audio", "data": inline["data"]})
            elif part.get("text") and not part.get("thought"):
                await send_json(local, {"type": "model_text", "text": part["text"]})
        if content.get("turnComplete"):
            await send_json(local, {"type": "turn_complete"})
        status = event.get("interactionStatus") or content.get("interactionStatus")
        if status:
            await send_json(local, {"type": "thinking_status", "status": status})
        tool_call = event.get("toolCall") or {}
        responses = []
        for call in tool_call.get("functionCalls") or []:
            name = call.get("name")
            if name == "get_local_time":
                now = datetime.now(ZoneInfo("Asia/Shanghai"))
                response = {"beijing_time": now.isoformat(timespec="seconds"),
                            "scheduling": "INTERRUPT"}
                await send_json(local, {"type": "tool", "name": name,
                                        "result": response["beijing_time"]})
            else:
                response = {"error": "工具不可用"}
                await send_json(local, {"type": "tool", "name": str(name),
                                        "result": "不可用"})
            responses.append({"id": call.get("id"), "name": name, "response": response})
        if responses:
            await send_json(upstream, {"toolResponse": {"functionResponses": responses}})


async def handle_gemini(local, values: dict[str, str], start: dict) -> None:
    model = "thinking" if start["model"] == "gemini_thinking" else "live"
    voice = start["voice"]
    tasks = []
    try:
        async with websockets.connect(f"{UPSTREAM}?key={values['GEMINI_API_KEY']}",
                open_timeout=20, close_timeout=5, max_size=16 * 1024 * 1024) as upstream:
            setup = setup_message(model, voice, start.get("instructions", ""), start.get("reasoning", "low"))
            await send_json(upstream, setup)
            deadline = asyncio.get_running_loop().time() + 20
            while True:
                event = json.loads(await asyncio.wait_for(
                        upstream.recv(), timeout=max(0.0, deadline - asyncio.get_running_loop().time())))
                if "error" in event:
                    await send_json(local, {"type": "error", "message": "Gemini 建连失败，请检查密钥、模型权限和额度。"})
                    return
                if "setupComplete" in event:
                    break
            await send_json(local, {"type": "ready", "model": MODELS[model], "voice": voice,
                "input_sample_rate": 16000, "output_sample_rate": 24000,
                "capabilities": [{"name": "get_local_time", "label": "查询本机北京时间"}]})
            tasks = [asyncio.create_task(from_browser(local, upstream)),
                     asyncio.create_task(from_gemini(local, upstream))]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
