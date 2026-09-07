#!/usr/bin/env python3
"""Real audio -> streaming ASR -> Codex -> durable usage, through a real server.

Uses the installed ASR models and current Codex/CC Switch account. No mock
fallback is permitted. Run with the project venv; artifacts stay under .runtime.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import uuid
import wave
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[1]


async def main(args) -> int:
    run = (
        ROOT
        / ".runtime"
        / "asr-codex-e2e"
        / (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6])
    )
    run.mkdir(parents=True, mode=0o700)
    audio = run / "speech.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "flite=text='reply with the number five':voice=slt",
            "-af",
            "adelay=500,apad=pad_dur=1.5",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(audio),
        ],
        check=True,
    )
    with wave.open(str(audio), "rb") as handle:
        pcm = handle.readframes(handle.getnframes())
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    env = {
        **os.environ,
        "PYTHONPATH": str(ROOT / "backend") + os.pathsep + str(ROOT),
        "DATABASE_URL": f"sqlite+aiosqlite:///{run / 'test.sqlite'}",
        "APP_ENV": "production",
        "CODEX_RUNTIME_DIR": str(run / "codex"),
        "PRELOAD_DEFAULT_ENGINE": "false",
    }
    report = {"passed": False, "real_asr": True, "real_codex": True, "gates": {}}
    log = (run / "backend.log").open("wb")
    server = None
    try:
        async with httpx.AsyncClient(base_url=base, timeout=180, trust_env=False) as client:

            def start_server():
                return subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "uvicorn",
                        "app.main:app",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(port),
                    ],
                    cwd=ROOT,
                    env=env,
                    stdout=log,
                    stderr=log,
                    start_new_session=os.name == "posix",
                )

            async def wait_ready():
                for _ in range(300):
                    if server.poll() is not None:
                        raise RuntimeError("Backend exited; inspect backend.log")
                    try:
                        if (await client.get("/v1/health", timeout=2)).is_success:
                            return
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.2)
                raise TimeoutError("Backend startup timed out")

            async def stop_server():
                if server.poll() is None:
                    server.terminate()
                    for _ in range(100):
                        if server.poll() is not None:
                            return
                        await asyncio.sleep(0.1)
                    server.kill()

            server = start_server()
            await wait_ready()
            model_response = await client.get("/v1/agents/codex/models")
            model_response.raise_for_status()
            catalogue = model_response.json()
            model = args.model or catalogue["configured_model"]
            report["model"] = model
            report["provider"] = catalogue["provider"]
            report["gates"]["model_catalog"] = bool(catalogue["models"])

            session_id = "voice-" + uuid.uuid4().hex
            events = []
            async with websockets.connect(
                f"ws://127.0.0.1:{port}/v1/stream", max_size=2**22, proxy=None
            ) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "type": "config",
                            "engine": "x-asr",
                            "language": "en",
                            "agent": {
                                "enabled": True,
                                "session_id": session_id,
                                "model": model,
                                "effort": "low",
                                "timeout_sec": 120,
                            },
                        }
                    )
                )
                while True:
                    event = json.loads(await asyncio.wait_for(ws.recv(), 120))
                    events.append(event)
                    if event["type"] == "error":
                        raise RuntimeError(event.get("message", "ASR failed"))
                    if event["type"] == "configured":
                        break

                async def send_audio():
                    # Deliberately small browser-like callbacks exercise VAD accumulation.
                    for offset in range(0, len(pcm), 256):
                        await ws.send(pcm[offset : offset + 256])
                        await asyncio.sleep(0.008)
                    await ws.send(json.dumps({"type": "end"}))

                sender = asyncio.create_task(send_audio())
                try:
                    while True:
                        event = json.loads(await asyncio.wait_for(ws.recv(), 150))
                        events.append(event)
                        if event["type"] in {"error", "agent.error"}:
                            raise RuntimeError(event.get("message", "Stream failed"))
                        if event["type"] == "done":
                            break
                    await sender
                finally:
                    if not sender.done():
                        sender.cancel()
                        await asyncio.gather(sender, return_exceptions=True)

            finals = [e for e in events if e["type"] == "final" and e.get("text", "").strip()]
            replies = [e["result"] for e in events if e["type"] == "agent.completed"]
            report["asr_text"] = [e["text"] for e in finals]
            report["answers"] = [e["text"] for e in replies]
            report["gates"]["speech_recognized"] = (
                bool(finals) and "five" in " ".join(report["asr_text"]).lower()
            )
            report["gates"]["final_once"] = bool(finals) and len(finals) == len(replies)
            report["gates"]["codex_answer"] = bool(replies) and all(
                e["status"] == "completed"
                and e["text"].strip().lower().rstrip(".。!") in {"5", "five", "五"}
                for e in replies
            )
            report["gates"]["streamed_answer"] = any(e["type"] == "agent.delta" for e in events)
            report["gates"]["done_after_agent"] = events[-1]["type"] == "done"
            report["gates"]["selected_model"] = bool(replies) and all(
                e["model"] == model for e in replies
            )
            report["gates"]["reported_usage"] = bool(replies) and all(
                e["usage"] and e["usage"]["total_tokens"] > 0 for e in replies
            )

            follow = await client.post(
                "/v1/agents/codex/turns",
                json={
                    "text": "What number did you just reply with? Reply with that number only.",
                    "session_id": session_id,
                    "model": model,
                    "effort": "low",
                },
            )
            follow.raise_for_status()
            follow_result = follow.json()
            report["follow_up"] = follow_result
            report["gates"]["conversation_continues"] = (
                bool(replies)
                and follow_result["thread_id"] == replies[-1]["thread_id"]
                and follow_result["text"].strip().rstrip(".。!") in {"5", "five", "Five"}
            )
            usage_response = await client.get(
                "/v1/agents/codex/usage", params={"session_id": session_id}
            )
            usage_response.raise_for_status()
            usage = usage_response.json()
            report["usage"] = usage
            known = sum(
                (e.get("usage") or {}).get("total_tokens", 0) for e in [*replies, follow_result]
            )
            report["gates"]["exact_usage_accounting"] = (
                usage["complete"]
                and usage["total_tokens"] == known
                and usage["calls"] == len(replies) + 1
            )

            # Restart the real FastAPI process and check durable accounting independently.
            await stop_server()
            server = start_server()
            await wait_ready()
            restored = (
                await client.get("/v1/agents/codex/usage", params={"session_id": session_id})
            ).json()
            report["gates"]["usage_survives_restart"] = (
                restored["total_tokens"] == usage["total_tokens"]
                and restored["calls"] == usage["calls"]
            )
            report["passed"] = all(report["gates"].values())
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        if server and server.poll() is None:
            server.terminate()
            for _ in range(100):
                if server.poll() is not None:
                    break
                await asyncio.sleep(0.1)
            if server.poll() is None:
                server.kill()
        log.close()
        path = run / "report.json"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({"report": str(path), **report}, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", help="Provider model ID; defaults to the current Codex config")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args)))
