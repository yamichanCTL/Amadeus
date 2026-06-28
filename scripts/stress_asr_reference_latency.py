#!/usr/bin/env python3
"""Warm-path HTTP stress test for the TTS reference-ASR result boundary."""

from __future__ import annotations

import argparse
import statistics
import time
from pathlib import Path

import requests


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * quantile)))
    return ordered[index]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--engine", default="sensevoice")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--budget-ms", type=float, default=500.0)
    args = parser.parse_args()

    audio = args.audio.read_bytes()
    url = f"{args.base_url.rstrip('/')}/v1/tts/higgs/reference-asr"
    latencies: list[float] = []
    expected_text = ""
    for index in range(args.runs + 1):
        started = time.perf_counter()
        response = requests.post(
            url,
            files={"audio": (args.audio.name, audio, "audio/wav")},
            data={"engine": args.engine, "language": args.language},
            timeout=120,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        response.raise_for_status()
        text = str(response.json().get("text") or "").strip()
        if not text:
            raise RuntimeError(f"run {index}: ASR returned empty text")
        if index == 0:
            expected_text = text
            continue
        if text != expected_text:
            raise RuntimeError(f"run {index}: unstable text: {text!r} != {expected_text!r}")
        latencies.append(elapsed_ms)

    p50 = statistics.median(latencies)
    p95 = percentile(latencies, 0.95)
    maximum = max(latencies)
    print(f"text={expected_text}")
    print(f"runs={len(latencies)} p50={p50:.1f}ms p95={p95:.1f}ms max={maximum:.1f}ms budget={args.budget_ms:.1f}ms")
    if p95 >= args.budget_ms:
        print("FAIL: warm-path p95 exceeded budget")
        return 1
    print("PASS: warm-path p95 is within budget")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
