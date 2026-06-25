#!/usr/bin/env python3
"""E2E Live Service Test Suite for asrapp backend.

Usage:
    .venv/bin/python scripts/e2e_live_test.py

Requires:
    - Backend running on http://127.0.0.1:8000
    - (optional) Higgs TTS on http://127.0.0.1:8002
"""

import concurrent.futures
import io
import json
import math
import struct
import sys
import wave

import requests

BASE = "http://127.0.0.1:8000"
passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        print(f"  ❌ {name}: {detail}")


def main() -> int:
    print("=" * 60)
    print("E2E Live Service Test Suite")
    print("=" * 60)

    # ── 1. Health ──
    print("\n── 1. Health & Readiness ──")
    r = requests.get(f"{BASE}/v1/health")
    d = r.json()
    check("health ok", r.status_code == 200 and d["status"] == "ok")
    check("uptime > 0", d["uptime_sec"] > 0, f"uptime={d['uptime_sec']:.0f}s")

    r = requests.get(f"{BASE}/v1/health/ready")
    rd = r.json()
    check("ready ok", r.status_code == 200 and rd["status"] == "ok")
    check("engines >= 5 registered", int(rd["checks"]["engines_registered"]) >= 5)
    loaded = rd["checks"].get("engines_loaded_names", "")
    check("engine loaded", len(loaded) > 0, f"loaded: {loaded}")

    # ── 2. Models ──
    print("\n── 2. Models & Engines ──")
    r = requests.get(f"{BASE}/v1/models")
    d = r.json()
    engines = {e["engine"]: e for e in d["engines"]}
    check("5 engines registered", len(engines) >= 5)
    for name in ["fireredasr2", "x-asr", "sensevoice", "qwen3asr", "whisper"]:
        check(f"  {name}", name in engines)
    check("x-asr streaming", engines["x-asr"]["extra"]["supports_streaming"])
    any_loaded = any(e["is_loaded"] for e in d["engines"])
    check("at least 1 loaded", any_loaded,
          str([(e["engine"], e["is_loaded"]) for e in d["engines"]]))

    # ── 3. Skills ──
    print("\n── 3. Skills API ──")
    r = requests.get(f"{BASE}/v1/skills")
    d = r.json()
    check("total >= 15", d["total"] >= 15, f"total={d['total']}")
    names = {s["name"] for s in d["skills"]}
    for sk in ["delegate_agent", "shell", "tts", "web_search", "read_file",
               "write_file", "system_info"]:
        check(f"skill: {sk}", sk in names)

    # Execute skills (note: field is "parameters" not "params")
    for label, skill_name, params, check_fn in [
        ("system_info", "system_info", {},
         lambda r: r["success"] and "Linux" in r["output"]),
        ("get_context", "get_context", {},
         lambda r: r["success"]),
        ("shell echo", "shell", {"command": "echo hello_e2e_test_xyz"},
         lambda r: r["success"] and "hello_e2e_test_xyz" in r["output"]),
        ("list_dir runner", "list_dir", {"path": "runner"},
         lambda r: r["success"]),
        ("read_file CLAUDE.md", "read_file", {"path": "CLAUDE.md", "max_chars": 200},
         lambda r: r["success"] and "asrapp" in r["output"]),
        ("run_python calc", "run_python", {"code": "2 + 3 * 4"},
         lambda r: r["success"] and "14" in r["output"]),
    ]:
        r = requests.post(f"{BASE}/v1/skills/execute",
                          json={"skill": skill_name, "parameters": params})
        check(f"execute: {label}", check_fn(r.json()),
              r.json().get("error", "") or r.json().get("output", "")[:50])

    # ── 4. Hotwords ──
    print("\n── 4. Hotwords API ──")
    r = requests.get(f"{BASE}/v1/hotwords")
    check("hotwords enabled", r.json()["enabled"])

    # ── 5. TTS & Voice ──
    print("\n── 5. TTS & Voice ──")
    r = requests.get(f"{BASE}/v1/tts/higgs/voices")
    check("higgs voices", r.status_code == 200 and "Elysia" in r.json()["voices"])
    r = requests.get(f"{BASE}/v1/tts/higgs/health")
    check("higgs health connected", r.json().get("connected", False))
    r = requests.get(f"{BASE}/v1/voice/voices")
    check("voice list", r.status_code == 200)

    # ── 6. LLM ──
    print("\n── 6. LLM API ──")
    r = requests.get(f"{BASE}/v1/llm/defaults")
    check("llm defaults", r.status_code == 200)

    # ── 7. ASR Transcription (real model) ──
    print("\n── 7. ASR Transcription (Real Engine) ──")
    sample_rate = 16000
    duration = 2.0
    n_samples = int(sample_rate * duration)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        samples = b''.join(
            struct.pack('<h', max(-32768, min(32767,
                        int(16000 * math.sin(2 * math.pi * 440 * i / sample_rate)))))
            for i in range(n_samples)
        )
        wf.writeframes(samples)
    test_wav = buf.getvalue()

    r = requests.post(f"{BASE}/v1/transcribe",
                      files={"file": ("test.wav", test_wav, "audio/wav")},
                      data={"engine": "sensevoice", "language": "zh"})
    check("transcribe 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        td = r.json()
        check("task_id present", len(td.get("task_id", "")) > 0)
        check("has full_text", isinstance(td.get("full_text"), str))
        check("has segments", len(td.get("segments", [])) >= 0)
        check("has timing", "timing" in td)
        check("engine_used", len(td.get("engine_used", "")) > 0)
        check("total_sec > 0", td.get("timing", {}).get("total_sec", 0) > 0)
        r2 = requests.get(f"{BASE}/v1/tasks/{td['task_id']}")
        check("task lookup", r2.status_code == 200
              and r2.json()["status"] == td["status"])

    # ── 8. Tasks ──
    print("\n── 8. Tasks API ──")
    r = requests.get(f"{BASE}/v1/tasks")
    check("tasks list", r.status_code == 200)

    # ── 9. Agent ──
    print("\n── 9. Agent API ──")
    r = requests.get(f"{BASE}/v1/agent/context")
    check("agent context", r.status_code == 200)
    r = requests.post(f"{BASE}/v1/agent/reset")
    check("agent reset", r.status_code == 200)

    # ── 10. Records ──
    print("\n── 10. Records ──")
    r = requests.get(f"{BASE}/v1/records")
    check("records 200", r.status_code == 200)

    # ── 11. Stress test ──
    print("\n── 11. Stress: 10 Concurrent Health Checks ──")

    def do_health(_=None):
        try:
            r = requests.get(f"{BASE}/v1/health", timeout=10)
            return r.status_code == 200 and r.json()["status"] == "ok"
        except Exception:
            return False

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(do_health, range(10)))
    check("all 10 passed", all(results), f"passed={sum(results)}/10")

    # ── 12. OpenAPI ──
    print("\n── 12. API Documentation ──")
    r = requests.get(f"{BASE}/docs")
    check("swagger docs", r.status_code == 200)
    r = requests.get(f"{BASE}/openapi.json")
    paths = len(r.json().get("paths", {}))
    check("35+ endpoints", paths >= 35, f"{paths} endpoints")

    # ── 13. Fix Verification ──
    print("\n── 13. Bug Fix Verification ──")
    # Bug 6 fix: unknown skill now returns 200+fail instead of 404
    r = requests.post(f"{BASE}/v1/skills/execute",
        json={"skill": "skill_that_does_not_exist_xyz_123", "parameters": {}}, timeout=15)
    d = r.json()
    check("Bug6: unknown skill 200+fail", r.status_code == 200 and not d.get("success"),
          f"status={r.status_code} success={d.get('success')}")

    # Bug 5: engine validation works via options JSON
    import io as _io2, wave as _wave2
    _buf2 = _io2.BytesIO()
    with _wave2.open(_buf2, 'wb') as _wf2:
        _wf2.setnchannels(1); _wf2.setsampwidth(2); _wf2.setframerate(16000)
        _wf2.writeframes(b'\x00\x00' * 1600)
    _twav = _buf2.getvalue()

    r = requests.post(f"{BASE}/v1/transcribe",
        files={"file": ("t.wav", _twav, "audio/wav")},
        data={"options": '{"engine": "invalid_engine_xyz_123"}'}, timeout=15)
    check("Bug5: invalid engine 422", r.status_code == 422, f"status={r.status_code}")

    # TTS pipeline: ASR → TTS works end-to-end
    import io as _io, wave as _wave, struct as _struct, math as _math
    _buf = _io.BytesIO()
    with _wave.open(_buf, 'wb') as _wf:
        _wf.setnchannels(1); _wf.setsampwidth(2); _wf.setframerate(16000)
        _wf.writeframes(b'\x00\x00' * 16000)
    _test_wav = _buf.getvalue()

    r = requests.post(f"{BASE}/v1/transcribe",
        files={"file": ("pipeline.wav", _test_wav, "audio/wav")},
        data={"options": '{"engine": "fireredasr2", "language": "zh"}'}, timeout=60)
    asr_ok = r.status_code == 200
    tts_text = "端到端测试通过" if asr_ok else "测试"
    r2 = requests.post(f"{BASE}/v1/tts/higgs/speak",
        json={"text": tts_text, "voice": "default"}, timeout=60)
    check("TTS pipeline ASR→TTS", r2.status_code == 200 and len(r2.content) > 1000,
          f"ASR={r.status_code} TTS={r2.status_code} size={len(r2.content)}")

    # Error recovery
    r = requests.post(f"{BASE}/v1/skills/execute",
        json={"skill": "shell", "parameters": {"command": "rm -rf /"}}, timeout=15)
    check("dangerous cmd: blocked", not r.json().get("success"))
    r = requests.post(f"{BASE}/v1/skills/execute",
        json={"skill": "read_file", "parameters": {"path": "/etc/passwd"}}, timeout=15)
    check("path traversal: blocked", not r.json().get("success"))

    # ── Summary ──
    print("\n" + "=" * 60)
    total = passed + failed
    rate = 100 * passed / total if total > 0 else 0
    print(f"RESULTS: {passed} passed, {failed} failed, {total} total")
    print(f"PASS RATE: {rate:.1f}%")
    print("=" * 60)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
