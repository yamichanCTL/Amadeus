"""Exercise FormalASR via a running Amadeus backend (no LLM or audio archive)."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="A Chinese speech WAV recording")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--dtype", default="bfloat16")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    audio = args.audio.read_bytes()
    with httpx.Client(base_url=args.base_url, timeout=600, trust_env=False) as client:
        start = time.perf_counter()
        loaded = client.post("/v1/models/formalasr/load", json={
            "model_name": "TaurenMountain/FormalASR-1.7B",
            "device": args.device, "compute_type": args.dtype,
        })
        loaded.raise_for_status()
        load_sec = time.perf_counter() - start
        options = {
            "engine": "formalasr", "language": "zh", "timeout_sec": 180,
            "enable_punctuation": False, "enable_hotwords": False,
            "allow_server_data_collection": False,
        }
        results = []
        for _ in range(2):
            start = time.perf_counter()
            response = client.post(
                "/v1/transcribe",
                files={"file": (args.audio.name, audio, "audio/wav")},
                data={"options": json.dumps(options)},
            )
            response.raise_for_status()
            result = response.json()
            assert result["engine_used"] == "formalasr", result
            assert result["full_text"].strip(), result
            assert not result["segments"], "Rewritten text must not claim aligned timestamps"
            assert not result.get("llm_outputs"), "This smoke test must not call an LLM"
            results.append({"wall_sec": round(time.perf_counter() - start, 3), **result})
    report = {
        "model": loaded.json(), "load_wall_sec": round(load_sec, 3),
        "audio_file": str(args.audio.resolve()), "results": results,
    }
    output = json.dumps(report, ensure_ascii=False, indent=2)
    print(output)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
