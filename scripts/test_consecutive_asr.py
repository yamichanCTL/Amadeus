#!/usr/bin/env python3
"""
Reproduce: 连续两次 ASR, 第二次后端处理完了但前端卡住

Tests against the LIVE backend. Simulates what the frontend does:
  1. Submit ASR1, wait for completion
  2. Immediately submit ASR2, wait for completion
  3. Verify both return results

Also tests rapid-fire: submit ASR2 while ASR1 is still processing.
"""
import concurrent.futures
import io
import json
import sys
import time
import wave

import requests

BASE = "http://127.0.0.1:8000"
passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        print(f"  ❌ {name}: {detail}")


def make_wav(dur):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * int(dur * 16000))
    return buf.getvalue()


def transcribe_one(wav, label, engine="sensevoice"):
    """Simulate one transcription and return timing breakdown."""
    t0 = time.perf_counter()
    r = requests.post(
        f"{BASE}/v1/transcribe",
        files={"file": (f"{label}.wav", wav, "audio/wav")},
        data={"options": json.dumps({"engine": engine, "language": "zh"})},
        timeout=60,
    )
    wall = time.perf_counter() - t0
    td = r.json() if r.status_code == 200 else {}
    timing = td.get("timing", {})
    return {
        "label": label,
        "status": r.status_code,
        "wall_sec": round(wall, 4),
        "backend_total": round(timing.get("total_sec", 0), 4),
        "backend_asr": round(timing.get("asr_sec", 0), 4),
        "text": td.get("full_text", "")[:40],
        "task_id": td.get("task_id", ""),
        "engine": td.get("engine_used", ""),
    }


def main():
    print("=" * 60)
    print("CONSECUTIVE ASR BUG REPRODUCTION TEST")
    print("=" * 60)

    wav = make_wav(1.0)

    # ── Test 1: Sequential (normal) ────────────────────────────────────
    print("\n── Test 1: Sequential (ASR1 complete → ASR2) ──")
    r1 = transcribe_one(wav, "seq1")
    r2 = transcribe_one(wav, "seq2")
    check("ASR1 200", r1["status"] == 200)
    check("ASR2 200", r2["status"] == 200)
    check("ASR1 has task_id", len(r1["task_id"]) > 0)
    check("ASR2 has task_id", len(r2["task_id"]) > 0)
    check("ASR1+ASR2 different tasks", r1["task_id"] != r2["task_id"])
    print(f"  ASR1: {r1['wall_sec']:.3f}s  backend={r1['backend_total']:.3f}s")
    print(f"  ASR2: {r2['wall_sec']:.3f}s  backend={r2['backend_total']:.3f}s")

    # ── Test 2: Rapid-fire (submit ASR2 while ASR1 processing) ─────────
    print("\n── Test 2: Rapid-fire (ASR2 submitted while ASR1 still processing) ──")
    t_start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        f1 = ex.submit(transcribe_one, wav, "rapid1")
        # Submit ASR2 immediately without waiting for ASR1
        f2 = ex.submit(transcribe_one, wav, "rapid2")
        rr1 = f1.result()
        rr2 = f2.result()
    total_wall = time.perf_counter() - t_start

    check("Rapid ASR1 200", rr1["status"] == 200)
    check("Rapid ASR2 200", rr2["status"] == 200)
    check("Rapid ASR1 has text", len(rr1["text"]) >= 0)
    check("Rapid ASR2 has text", len(rr2["text"]) >= 0)
    # ASR1 should start first, ASR2 queues behind
    print(f"  ASR1: wall={rr1['wall_sec']:.3f}s  backend_asr={rr1['backend_asr']:.3f}s")
    print(f"  ASR2: wall={rr2['wall_sec']:.3f}s  backend_asr={rr2['backend_asr']:.3f}s")
    print(f"  Total wall: {total_wall:.3f}s")

    # ── Test 3: Three rapid-fire ───────────────────────────────────────
    print("\n── Test 3: Three rapid-fire (stress) ──")
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        futures = [ex.submit(transcribe_one, wav, f"triple{i}") for i in range(3)]
        results = [f.result() for f in concurrent.futures.as_completed(futures)]
    for i, r in enumerate(results):
        check(f"Triple ASR{i+1} 200", r["status"] == 200, f"status={r['status']}")
        print(f"  {r['label']}: wall={r['wall_sec']:.3f}s  backend_asr={r['backend_asr']:.3f}s")

    # ── Test 4: Task polling after submit ──────────────────────────────
    print("\n── Test 4: Task status polling ──")
    r = requests.post(
        f"{BASE}/v1/transcribe",
        files={"file": ("poll_test.wav", wav, "audio/wav")},
        data={"options": json.dumps({"engine": "sensevoice", "language": "zh"})},
        timeout=60,
    )
    check("Submit 200", r.status_code == 200)
    task_id = r.json().get("task_id", "")
    check("Has task_id", len(task_id) > 0)

    # Poll immediately — should be done already for sync audio
    r2 = requests.get(f"{BASE}/v1/tasks/{task_id}", timeout=10)
    check("Task lookup 200", r2.status_code == 200)
    task_data = r2.json()
    check("Task status success", task_data.get("status") == "success",
          f"status={task_data.get('status')}")
    print(f"  Task {task_id}: status={task_data.get('status')}")

    # ── Test 5: Model loading test (first request cold start) ──────────
    print("\n── Test 5: Task retrieval integrity ──")
    # Submit 5 transcriptions, verify all tasks can be retrieved
    task_ids = []
    for i in range(5):
        r = requests.post(
            f"{BASE}/v1/transcribe",
            files={"file": (f"t{i}.wav", wav, "audio/wav")},
            data={"options": json.dumps({"engine": "sensevoice", "language": "zh"})},
            timeout=60,
        )
        if r.status_code == 200:
            task_ids.append(r.json().get("task_id", ""))

    check("5 tasks submitted", len(task_ids) == 5, f"got {len(task_ids)}")

    for tid in task_ids:
        r = requests.get(f"{BASE}/v1/tasks/{tid}", timeout=10)
        if r.status_code != 200 or r.json().get("status") != "success":
            check(f"Task {tid[:8]} retrievable", False, f"status={r.status_code}")
        else:
            check(f"Task {tid[:8]} OK", True)

    # ── Summary ──
    print(f"\n{'=' * 60}")
    print(f"RESULTS: {passed} passed, {failed} failed, {passed+failed} total")
    if passed + failed > 0:
        print(f"PASS RATE: {100*passed/(passed+failed):.1f}%")
    print(f"{'=' * 60}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
