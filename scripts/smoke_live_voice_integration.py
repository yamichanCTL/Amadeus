"""Bounded, opt-in checks against the integrated Amadeus voice endpoints.

Does not read credentials. Live calls require --run; Grok and OpenAI are excluded.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import time
import wave
from pathlib import Path

import httpx
import websockets


async def check(base: str, provider: dict, fixture: Path | None = None) -> dict:
    started = time.monotonic()
    result = {"provider": provider["id"], "model": provider["model"],
              "audio_chunks": 0, "audio_bytes": 0, "input_text": "",
              "output_text": "", "tools": [], "complete": False}
    async with websockets.connect(base.replace("http", "ws", 1) + "/v1/live-voice/ws",
                                  origin="http://localhost:5173", max_size=2**21) as ws:
        await ws.send(json.dumps({"type": "start", "model": provider["id"],
                                 "voice": provider["default_voice"], "brain": "off",
                                 "instructions": "你是爱弥斯。回答简短，只用一句话。询问时间时使用已有工具。"}))
        event = json.loads(await asyncio.wait_for(ws.recv(), 30))
        if event.get("type") != "ready":
            raise RuntimeError(f"{provider['id']}: expected ready, got {event.get('type')}")
        result["ready_ms"] = round((time.monotonic() - started) * 1000)

        async def send_input():
            if not fixture:
                await ws.send(json.dumps({"type": "text", "text": "请调用工具查询北京时间，用一句中文报时。"}))
                return
            with wave.open(str(fixture), "rb") as stream:
                if (stream.getnchannels(), stream.getsampwidth(), stream.getframerate()) != (1, 2, 16000):
                    raise ValueError("Fixture must be mono PCM16 at 16 kHz")
                pcm = stream.readframes(stream.getnframes())
            # Real-time pacing, then one second of trailing silence.
            for pos in range(0, len(pcm) + 32000, 3200):
                chunk = pcm[pos:pos + 3200] if pos < len(pcm) else bytes(3200)
                await ws.send(json.dumps({"type": "audio", "data": base64.b64encode(chunk).decode()}))
                await asyncio.sleep(.1)
            await ws.send(json.dumps({"type": "audio_end"}))

        sender = asyncio.create_task(send_input())
        deadline = time.monotonic() + 45
        try:
            while time.monotonic() < deadline:
                event = json.loads(await asyncio.wait_for(ws.recv(), max(.1, deadline - time.monotonic())))
                kind = event.get("type")
                if kind == "error":
                    result["error"] = event.get("message", "Provider error")
                    break
                if kind == "audio":
                    result.setdefault("first_audio_ms", round((time.monotonic() - started) * 1000))
                    result["audio_chunks"] += 1
                    result["audio_bytes"] += len(base64.b64decode(event["data"]))
                elif kind == "output_transcript":
                    result["output_text"] += event.get("text", "")
                elif kind == "input_transcript":
                    text = event.get("text", "")
                    if provider["id"].startswith("gemini"):
                        result["input_text"] += text
                    else:
                        result["input_text"] = text
                elif kind == "tool":
                    result["tools"].append(event.get("name"))
                elif (kind == "turn_complete" and result["audio_chunks"] and result["output_text"]
                      and (result["input_text"] if fixture else result["tools"])):
                    # Extended thinking may finish a spoken acknowledgement while
                    # its non-blocking tool is still pending. Wait for the result.
                    result["complete"] = True
                    break
        except TimeoutError:
            result["error"] = "Timed out waiting for a complete audible response"
        finally:
            if not sender.done():
                sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
    result["elapsed_s"] = round(time.monotonic() - started, 2)
    result["passed"] = bool(result["complete"] and result["audio_chunks"] and
                            (result["input_text"] if fixture else result["tools"]))
    return result


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Use existing provider quota for short live sessions")
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--models", nargs="+", choices=["qwen", "gemini_live", "gemini_thinking", "higgs"],
                        default=["qwen", "gemini_live", "gemini_thinking", "higgs"])
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.get(args.base + "/v1/live-voice/catalog")
        response.raise_for_status()
        catalog = response.json()
    selected = [p for p in catalog["providers"] if p["id"] in args.models]
    print(json.dumps({"mode": "live" if args.run else "catalog_only", "providers": [
        {k: p.get(k) for k in ("id", "model", "configured", "available")} for p in selected]}, ensure_ascii=False))
    if not args.run:
        return
    results = []
    for provider in selected:
        if not provider["available"]:
            results.append({"provider": provider["id"], "passed": False, "error": "Provider unavailable"})
            continue
        result = await check(args.base, provider, args.fixture)
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    if not all(r["passed"] for r in results):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
