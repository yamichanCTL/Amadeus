#!/usr/bin/env python3
"""Run a real X-ASR online decode and prove the CUDA provider is usable."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.core.asr.engines.x_asr import XASREngine

import librosa
import numpy as np
import soundfile as sf


def gpu_process_memory(pid: int) -> str:
    result = subprocess.run(
        ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        check=False,
    )
    target_pid = str(pid)
    for line in result.stdout.splitlines():
        columns = [item.strip() for item in line.split(",")]
        if columns and columns[0] == target_pid:
            return f"{columns[1]} MiB" if len(columns) > 1 else "detected"
    return "not-reported"


def gpu_used_memory() -> int | None:
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        return int(result.stdout.splitlines()[0].strip())
    except (IndexError, ValueError):
        return None


async def main() -> None:
    model_name = os.getenv("X_ASR_MODEL", "chunk-160ms-model")
    device = os.getenv("X_ASR_DEVICE", "cuda")
    model_dir = ROOT / "thirdparty/X-ASR/X-ASR-zh-en/deployment/models" / model_name
    sample = Path(os.getenv(
        "ASR_SAMPLE",
        "data/archive/yami/2026-06-04/实时转写/2026-06-04_00-02-49_qwen3asr_691252.wav",
    ))
    if not sample.is_file():
        raise FileNotFoundError(f"ASR sample not found: {sample}")
    audio, sample_rate = sf.read(sample, dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)[: int(sample_rate * 6.8)]
    if sample_rate != 16_000:
        mono = librosa.resample(mono, orig_sr=sample_rate, target_sr=16_000)
    pcm = np.clip(mono * 32768.0, -32768, 32767).astype("<i2")

    engine = XASREngine(model_name=model_name, model_dir=str(model_dir), device=device)
    started = time.perf_counter()
    gpu_before = gpu_used_memory()
    try:
        await engine.load()
        gpu_after_load = gpu_used_memory()
        stream = await engine.create_streaming_session(16_000)
        partials: list[str] = []
        for start in range(0, len(pcm), 512):
            result = await stream.accept_pcm(pcm[start : start + 512].tobytes())
            if result and result.full_text:
                partials.append(result.full_text)
        await stream.accept_pcm(np.zeros(16_000, dtype="<i2").tobytes())
        final = await stream.finish()
        info = engine.info()
        if device == "cuda" and (info.get("device") != "cuda" or "+cuda" not in str(info.get("runtime_version"))):
            raise RuntimeError(f"X-ASR did not load a CUDA runtime: {info}")
        if info.get("device") != device:
            raise RuntimeError(f"X-ASR loaded an unexpected provider: {info}")
        if not partials or not final.full_text:
            raise RuntimeError("X-ASR CUDA decode did not produce partial/final text")
        print({
            "runtime": info.get("runtime_version"),
            "model": info.get("model_name"),
            "chunk_ms": info.get("chunk_ms"),
            "provider": info.get("device"),
            "worker_pid": info.get("worker_pid"),
            "gpu_process_memory": gpu_process_memory(int(info.get("worker_pid") or os.getpid())),
            "gpu_used_before_mib": gpu_before,
            "gpu_used_after_load_mib": gpu_after_load,
            "gpu_load_delta_mib": (
                gpu_after_load - gpu_before
                if gpu_before is not None and gpu_after_load is not None
                else None
            ),
            "chunks": (len(pcm) + 511) // 512,
            "partials": len(partials),
            "finals": 1,
            "elapsed_sec": round(time.perf_counter() - started, 3),
            "final_text": final.full_text,
        })
    finally:
        await engine.unload()


if __name__ == "__main__":
    asyncio.run(main())
