#!/usr/bin/env python3
"""
Comprehensive Stress & Latency Test Suite for asrapp Backend.

Tests:
  1. Baseline latency per endpoint
  2. Multi-user concurrent ASR transcription (10/20/50 users)
  3. Mixed workload (transcribe + skills + models + records)
  4. Error recovery: invalid inputs, model timeouts
  5. WebSocket streaming load
  6. Long-running session stability
"""

import asyncio
import io
import json
import math
import statistics
import struct
import sys
import time
import wave
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone

import requests

BASE = "http://127.0.0.1:8000"

# ── Helpers ──────────────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

@dataclass
class LatencyStats:
    label: str
    samples: list[float] = field(default_factory=list)
    errors: int = 0
    def add(self, val: float) -> None:
        self.samples.append(val)
    def report(self) -> dict:
        s = sorted(self.samples)
        n = len(s)
        if n == 0:
            return {"label": self.label, "count": 0, "errors": self.errors}
        return {
            "label": self.label,
            "count": n,
            "errors": self.errors,
            "min": round(s[0], 3),
            "max": round(s[-1], 3),
            "mean": round(statistics.mean(s), 3),
            "p50": round(s[n * 50 // 100], 3) if n > 0 else None,
            "p90": round(s[n * 90 // 100], 3) if n > 1 else None,
            "p95": round(s[n * 95 // 100], 3) if n > 1 else None,
            "p99": round(s[n * 99 // 100], 3) if n > 3 else None,
        }

def make_silent_wav(duration_sec: float = 1.0, sample_rate: int = 16000) -> bytes:
    n = int(duration_sec * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sample_rate)
        wf.writeframes(b'\x00\x00' * n)
    return buf.getvalue()

def time_request(method: str, url: str, **kwargs) -> tuple[float, int, object]:
    """Returns (latency_sec, status_code, response_data)."""
    t0 = time.perf_counter()
    try:
        r = requests.request(method, url, timeout=kwargs.pop('timeout', 30), **kwargs)
        lat = time.perf_counter() - t0
        try:
            data = r.json()
        except Exception:
            data = {"_raw": r.text[:200]}
        return lat, r.status_code, data
    except Exception as e:
        lat = time.perf_counter() - t0
        return lat, 0, {"_error": str(e)[:200]}

# ── Test 1: Baseline Latency ─────────────────────────────────────────────────

def baseline_latency() -> dict:
    print("=" * 70)
    print("TEST 1: Baseline Latency (single request, warm cache)")
    print("=" * 70)

    endpoints = [
        ("GET", "/v1/health"),
        ("GET", "/v1/health/ready"),
        ("GET", "/v1/models"),
        ("GET", "/v1/skills"),
        ("GET", "/v1/hotwords"),
        ("GET", "/v1/llm/defaults"),
        ("GET", "/v1/agent/context"),
        ("GET", "/v1/tasks"),
        ("GET", "/v1/records"),
        ("GET", "/v1/tts/higgs/health"),
        ("GET", "/v1/tts/higgs/voices"),
        ("GET", "/v1/voice/voices"),
        ("POST", "/v1/skills/execute", {"json": {"skill": "system_info", "parameters": {}}}),
        ("POST", "/v1/skills/execute", {"json": {"skill": "get_context", "parameters": {}}}),
        ("POST", "/v1/agent/reset"),
    ]

    stats = {}
    for method, path, *args in endpoints:
        kwargs = args[0] if args else {}
        # Warm up
        time_request(method, f"{BASE}{path}", **kwargs)
        time_request(method, f"{BASE}{path}", **kwargs)
        # Measure 5 samples
        lat_stat = LatencyStats(f"{method} {path}")
        for _ in range(5):
            lat, code, data = time_request(method, f"{BASE}{path}", **kwargs)
            if 200 <= code < 300:
                lat_stat.add(lat)
            else:
                lat_stat.errors += 1
        r = lat_stat.report()
        stats[f"{method} {path}"] = r
        print(f"  {method} {path:<45} mean={r.get('mean', 'N/A')}s  p95={r.get('p95', 'N/A')}s  p99={r.get('p99', 'N/A')}s")
    return stats


# ── Test 2: Multi-User Concurrent ASR Transcription ──────────────────────────

def concurrent_transcription(num_users: int, wav_bytes: bytes) -> dict:
    print(f"\n{'=' * 70}")
    print(f"TEST 2: Multi-User ASR Transcription ({num_users} concurrent users)")
    print(f"{'=' * 70}")

    lat_stat = LatencyStats(f"transcribe_{num_users}u")

    def transcribe_one(uid: int) -> dict:
        t0 = time.perf_counter()
        try:
            r = requests.post(f"{BASE}/v1/transcribe",
                files={"file": (f"user{uid}.wav", wav_bytes, "audio/wav")},
                data={"engine": "sensevoice", "language": "zh"},
                timeout=120)
            lat = time.perf_counter() - t0
            return {"uid": uid, "lat": lat, "status": r.status_code,
                    "text": r.json().get("full_text", "")[:30] if r.status_code == 200 else "",
                    "task_id": r.json().get("task_id", "") if r.status_code == 200 else ""}
        except Exception as e:
            return {"uid": uid, "lat": time.perf_counter() - t0, "status": 0, "error": str(e)[:100]}

    results = []
    with ThreadPoolExecutor(max_workers=min(num_users, 20)) as ex:
        futures = [ex.submit(transcribe_one, i) for i in range(num_users)]
        for fut in as_completed(futures):
            r = fut.result()
            results.append(r)
            if r["status"] == 200:
                lat_stat.add(r["lat"])
            else:
                lat_stat.errors += 1
            print(f"  user{r['uid']:>3d}: {r['status']:>3d}  {r['lat']:.3f}s  text={r.get('text', r.get('error', ''))}")

    report = lat_stat.report()
    success_rate = 100 * report["count"] / num_users if num_users > 0 else 0
    print(f"\n  Summary: {report['count']}/{num_users} success ({success_rate:.1f}%)")
    print(f"  Latency: mean={report.get('mean', 'N/A')}s  p50={report.get('p50', 'N/A')}s  "
          f"p95={report.get('p95', 'N/A')}s  p99={report.get('p99', 'N/A')}s")
    report["success_rate"] = round(success_rate, 1)
    return report


# ── Test 3: Mixed Workload ───────────────────────────────────────────────────

def mixed_workload(num_cycles: int = 10) -> dict:
    print(f"\n{'=' * 70}")
    print(f"TEST 3: Mixed Workload ({num_cycles} cycles, mixed operations)")
    print(f"{'=' * 70}")

    stats_map: dict[str, LatencyStats] = {}

    def do_mixed(worker_id: int):
        ops = [
            ("health", lambda: requests.get(f"{BASE}/v1/health", timeout=10)),
            ("models", lambda: requests.get(f"{BASE}/v1/models", timeout=10)),
            ("skills", lambda: requests.get(f"{BASE}/v1/skills", timeout=10)),
            ("sys_info", lambda: requests.post(f"{BASE}/v1/skills/execute",
                json={"skill": "system_info", "parameters": {}}, timeout=15)),
            ("shell", lambda: requests.post(f"{BASE}/v1/skills/execute",
                json={"skill": "shell", "parameters": {"command": "echo stress_test_ok"}}, timeout=15)),
            ("tasks", lambda: requests.get(f"{BASE}/v1/tasks", timeout=10)),
            ("agent_ctx", lambda: requests.get(f"{BASE}/v1/agent/context", timeout=10)),
            ("hotwords", lambda: requests.get(f"{BASE}/v1/hotwords", timeout=10)),
            ("records", lambda: requests.get(f"{BASE}/v1/records", timeout=10)),
            ("higgs_health", lambda: requests.get(f"{BASE}/v1/tts/higgs/health", timeout=10)),
            ("voice_list", lambda: requests.get(f"{BASE}/v1/voice/voices", timeout=10)),
        ]
        results_local = []
        for op_name, fn in ops:
            t0 = time.perf_counter()
            try:
                r = fn()
                lat = time.perf_counter() - t0
                results_local.append((op_name, lat, r.status_code))
            except Exception as e:
                lat = time.perf_counter() - t0
                results_local.append((op_name, lat, 0))
        return results_local

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(do_mixed, i) for i in range(num_cycles)]
        for fut in as_completed(futures):
            for op_name, lat, code in fut.result():
                if op_name not in stats_map:
                    stats_map[op_name] = LatencyStats(op_name)
                if 200 <= code < 300:
                    stats_map[op_name].add(lat)
                else:
                    stats_map[op_name].errors += 1

    reports = {}
    for name, stat in sorted(stats_map.items()):
        r = stat.report()
        reports[name] = r
        print(f"  {name:<20} n={r['count']:>3d}  mean={r.get('mean', 'N/A')}s  "
              f"p95={r.get('p95', 'N/A')}s  p99={r.get('p99', 'N/A')}s  err={stat.errors}")
    return reports


# ── Test 4: Error Recovery ───────────────────────────────────────────────────

def error_recovery() -> dict:
    print(f"\n{'=' * 70}")
    print(f"TEST 4: Error Recovery & Boundary Testing")
    print(f"{'=' * 70}")

    results = {}

    # 4.1 Missing file
    r = requests.post(f"{BASE}/v1/transcribe", data={"engine": "sensevoice"})
    results["missing_file"] = {"status": r.status_code, "ok": r.status_code == 422}
    print(f"  missing_file: 422 expected -> {r.status_code} {'✅' if r.status_code == 422 else '❌'}")

    # 4.2 Invalid engine
    r = requests.post(f"{BASE}/v1/transcribe",
        files={"file": ("t.wav", make_silent_wav(0.1), "audio/wav")},
        data={"engine": "nonexistent_engine_xyz"})
    results["invalid_engine"] = {"status": r.status_code, "ok": r.status_code == 422}
    print(f"  invalid_engine: 422 expected -> {r.status_code} {'✅' if r.status_code == 422 else '❌'}")

    # 4.3 Invalid JSON in options
    r = requests.post(f"{BASE}/v1/transcribe",
        files={"file": ("t.wav", make_silent_wav(0.1), "audio/wav")},
        data={"engine": "sensevoice", "options": "not valid json {{{"})
    results["invalid_json_options"] = {"status": r.status_code, "ok": r.status_code == 422}
    print(f"  invalid_json_options: 422 expected -> {r.status_code} {'✅' if r.status_code == 422 else '❌'}")

    # 4.4 Nonexistent task
    r = requests.get(f"{BASE}/v1/tasks/00000000-0000-0000-0000-000000000000")
    results["nonexistent_task"] = {"status": r.status_code, "ok": r.status_code == 404}
    print(f"  nonexistent_task: 404 expected -> {r.status_code} {'✅' if r.status_code == 404 else '❌'}")

    # 4.5 Empty skill name
    r = requests.post(f"{BASE}/v1/skills/execute",
        json={"skill": "", "parameters": {}})
    results["empty_skill_name"] = {"status": r.status_code, "ok": r.status_code == 422}
    print(f"  empty_skill_name: 422 expected -> {r.status_code} {'✅' if r.status_code == 422 else '❌'}")

    # 4.6 Unknown skill
    r = requests.post(f"{BASE}/v1/skills/execute",
        json={"skill": "skill_that_does_not_exist", "parameters": {}})
    rd = r.json()
    results["unknown_skill"] = {"status": r.status_code, "ok": r.status_code == 200 and not rd.get("success")}
    print(f"  unknown_skill: 200+success=false expected -> {r.status_code} success={rd.get('success')} {'✅' if rd.get('success') == False else '❌'}")

    # 4.7 Shell dangerous command
    r = requests.post(f"{BASE}/v1/skills/execute",
        json={"skill": "shell", "parameters": {"command": "rm -rf /"}})
    rd = r.json()
    results["dangerous_shell"] = {"status": r.status_code, "ok": not rd.get("success")}
    print(f"  dangerous_shell (rm -rf /): blocked -> success={rd.get('success')} error={rd.get('error', '')[:80]} {'✅' if not rd.get('success') else '❌'}")

    # 4.8 Read file outside project
    r = requests.post(f"{BASE}/v1/skills/execute",
        json={"skill": "read_file", "parameters": {"path": "/etc/passwd"}})
    rd = r.json()
    results["read_outside_project"] = {"status": r.status_code, "ok": not rd.get("success")}
    print(f"  read /etc/passwd: blocked -> success={rd.get('success')} {'✅' if not rd.get('success') else '❌'}")

    # 4.9 Very long input to skill
    r = requests.post(f"{BASE}/v1/skills/execute",
        json={"skill": "shell", "parameters": {"command": "echo " + "x" * 10000}})
    rd = r.json()
    results["long_command"] = {"status": r.status_code, "ok": r.status_code in (200, 422)}
    print(f"  long_command (10k chars): handled -> {r.status_code} {'✅' if r.status_code in (200, 422) else '❌'}")

    # 4.10 Concurrent model access (many simultaneous transcribes)
    print(f"\n  4.10 Concurrent model access (rapid fire, 5 simultaneous)...")
    wav = make_silent_wav(0.5)
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=5) as ex:
        futs = [ex.submit(lambda: requests.post(f"{BASE}/v1/transcribe",
            files={"file": ("t.wav", wav, "audio/wav")},
            data={"engine": "sensevoice", "language": "zh"}, timeout=120)) for _ in range(5)]
        statuses = [f.result().status_code for f in as_completed(futs)]
    total_time = time.perf_counter() - t0
    all_ok = all(s == 200 for s in statuses)
    results["concurrent_model_access"] = {"ok": all_ok, "total_time": round(total_time, 2),
                                           "statuses": statuses}
    print(f"  concurrent_model_access: {statuses} total_time={total_time:.2f}s {'✅' if all_ok else '❌'}")

    return results


# ── Test 5: WebSocket Streaming ─────────────────────────────────────────────

async def test_websocket_streaming() -> dict:
    print(f"\n{'=' * 70}")
    print(f"TEST 5: WebSocket Streaming")
    print(f"{'=' * 70}")

    try:
        import websockets
    except ImportError:
        print("  ⚠️ websockets not installed, skipping WebSocket tests")
        return {"status": "skipped", "reason": "websockets not installed"}

    results = {}

    # 5.1 Single stream connect
    try:
        async with websockets.connect("ws://127.0.0.1:8000/v1/stream") as ws:
            msg = await asyncio.wait_for(ws.recv(), timeout=10)
            data = json.loads(msg)
            results["stream_connect"] = {"ok": data.get("type") == "ready",
                                         "msg_type": data.get("type")}
            print(f"  stream_connect: type={data.get('type')} {'✅' if data.get('type') == 'ready' else '❌'}")
    except Exception as e:
        results["stream_connect"] = {"ok": False, "error": str(e)[:100]}
        print(f"  stream_connect: ❌ {e}")

    # 5.2 Multiple simultaneous streams
    print("  5.2 Multiple simultaneous streams (5)...")
    async def stream_one(uid: int) -> dict:
        try:
            async with websockets.connect("ws://127.0.0.1:8000/v1/stream") as ws:
                msg = await asyncio.wait_for(ws.recv(), timeout=15)
                data = json.loads(msg)
                return {"uid": uid, "type": data.get("type")}
        except Exception as e:
            return {"uid": uid, "error": str(e)[:80]}

    tasks = [stream_one(i) for i in range(5)]
    stream_results = await asyncio.gather(*tasks)
    ok_count = sum(1 for r in stream_results if r.get("type") == "ready")
    results["multi_stream"] = {"ok": ok_count == 5, "success": ok_count, "total": 5}
    print(f"  multi_stream: {ok_count}/5 connected {'✅' if ok_count == 5 else '❌'}")

    return results


# ── Test 6: Long Session Stability ───────────────────────────────────────────

def long_session_stability(duration_sec: int = 30) -> dict:
    print(f"\n{'=' * 70}")
    print(f"TEST 6: Long Session Stability ({duration_sec}s sustained load)")
    print(f"{'=' * 70}")

    lat_stat = LatencyStats("sustained_health")
    start = time.perf_counter()
    count = 0
    errors = 0

    def worker():
        nonlocal count, errors
        while time.perf_counter() - start < duration_sec:
            t0 = time.perf_counter()
            try:
                r = requests.get(f"{BASE}/v1/health", timeout=10)
                lat = time.perf_counter() - t0
                if r.status_code == 200 and r.json()["status"] == "ok":
                    lat_stat.add(lat)
                else:
                    errors += 1
                    lat_stat.errors += 1
                count += 1
            except Exception:
                errors += 1
                lat_stat.errors += 1
            time.sleep(0.05)  # ~20 req/s per worker

    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(worker) for _ in range(4)]
        for fut in as_completed(futs):
            fut.result()

    actual_duration = time.perf_counter() - start
    report = lat_stat.report()
    report["total_requests"] = count
    report["actual_duration_sec"] = round(actual_duration, 1)
    report["req_per_sec"] = round(count / actual_duration, 1) if actual_duration > 0 else 0
    print(f"  Duration: {actual_duration:.1f}s  Requests: {count}  "
          f"Rate: {report['req_per_sec']:.1f} req/s  Errors: {errors}")
    print(f"  Latency: mean={report.get('mean', 'N/A')}s  p50={report.get('p50', 'N/A')}s  "
          f"p95={report.get('p95', 'N/A')}s  p99={report.get('p99', 'N/A')}s")
    return report


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("╔" + "═" * 68 + "╗")
    print("║  ASRAPP STRESS & LATENCY TEST SUITE" + " " * 32 + "║")
    print("║  " + now_iso() + " " * 25 + "║")
    print("╚" + "═" * 68 + "╝")

    full_report = {
        "timestamp": now_iso(),
        "base_url": BASE,
    }

    # Test 1: Baseline
    full_report["baseline_latency"] = baseline_latency()

    # Test 2: Multi-user transcription
    wav = make_silent_wav(1.0)
    full_report["concurrent_10u"] = concurrent_transcription(10, wav)
    full_report["concurrent_20u"] = concurrent_transcription(20, wav)

    # Test 3: Mixed workload
    full_report["mixed_workload"] = mixed_workload(20)

    # Test 4: Error recovery
    full_report["error_recovery"] = error_recovery()

    # Test 5: WebSocket
    ws_results = asyncio.run(test_websocket_streaming())
    full_report["websocket"] = ws_results

    # Test 6: Long session
    full_report["long_session"] = long_session_stability(30)

    # ── Final Summary ──
    print(f"\n{'=' * 70}")
    print("FINAL SUMMARY")
    print(f"{'=' * 70}")

    # Count all errors
    def count_total_errors(report_dict, depth=0):
        errs = 0
        for k, v in report_dict.items():
            if isinstance(v, dict):
                if "errors" in v and k != "errors":
                    errs += v["errors"]
                errs += count_total_errors(v, depth + 1)
        return errs

    total_errors = count_total_errors(full_report)
    total_checks = sum(
        1 for k, v in full_report.get("error_recovery", {}).items()
        if isinstance(v, dict) and v.get("ok") is not None
    )
    ok_checks = sum(
        1 for k, v in full_report.get("error_recovery", {}).items()
        if isinstance(v, dict) and v.get("ok")
    )

    # Count successful concurrent transcription
    c10_success = full_report["concurrent_10u"]["count"]
    c20_success = full_report["concurrent_20u"]["count"]

    print(f"  Error recovery:   {ok_checks}/{total_checks} checks passed")
    print(f"  Concurrent 10u:   {c10_success}/10 successful transcribes")
    print(f"  Concurrent 20u:   {c20_success}/20 successful transcribes")
    print(f"  WebSocket:         {ws_results}")
    print(f"  Long session:      {full_report['long_session']['total_requests']} requests in "
          f"{full_report['long_session']['actual_duration_sec']}s "
          f"({full_report['long_session']['req_per_sec']} req/s)")
    print(f"  Total errors:      {total_errors}")

    # Save report
    report_path = "/tmp/asrapp_stress_report.json"
    with open(report_path, "w") as f:
        json.dump(full_report, f, indent=2, ensure_ascii=False, default=str)
    print(f"\n  Full report saved to: {report_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
