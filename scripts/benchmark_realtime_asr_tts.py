#!/usr/bin/env python3
"""Measure real-time X-ASR -> incremental text -> Higgs PCM first audio."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import re
import time
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import websockets


def _load_pcm16(path: Path, target_rate: int = 16_000) -> tuple[np.ndarray, int]:
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sample_rate != target_rate:
        duration = len(audio) / sample_rate
        source_x = np.linspace(0.0, duration, len(audio), endpoint=False)
        target_x = np.linspace(0.0, duration, int(duration * target_rate), endpoint=False)
        audio = np.interp(target_x, source_x, audio)
    window = max(1, int(target_rate * 0.032))
    speech_windows = []
    for offset in range(0, max(0, len(audio) - window), window):
        rms = float(np.sqrt(np.mean(audio[offset : offset + window] ** 2)))
        speech_windows.append(rms >= 450.0 / 32768.0)
    onset = 0
    required = max(1, int(np.ceil(0.08 / (window / target_rate))))
    for index in range(0, max(0, len(speech_windows) - required + 1)):
        if all(speech_windows[index : index + required]):
            onset = index * window
            break
    start = max(0, onset - int(target_rate * 0.1))
    audio = audio[start:]
    pcm = np.clip(audio * 32768.0, -32768, 32767).astype("<i2")
    return pcm, onset - start


async def benchmark(args: argparse.Namespace) -> dict[str, Any]:
    pcm, onset_offset = _load_pcm16(args.audio)
    chunk_samples = int(args.sample_rate * args.chunk_ms / 1000)
    leading = np.zeros(int(args.sample_rate * args.leading_silence), dtype="<i2")
    trailing = np.zeros(int(args.sample_rate * args.trailing_silence), dtype="<i2")
    stream = np.concatenate([leading, pcm, trailing])
    speech_sample_index = len(leading) + onset_offset

    marks: dict[str, float] = {}
    first_text = ""
    final_texts: list[str] = []
    tts_segments: list[dict[str, Any]] = []
    playback_buffer_until = 0.0
    playback_underrun_s = 0.0
    trimmed_silence_ms = 0.0
    tail_silence_aborted_count = 0
    first_audio_server = 0.0
    events: list[str] = []
    event_details: list[dict[str, Any]] = []
    errors: list[str] = []
    configured = asyncio.Event()

    async with websockets.connect(args.websocket, max_size=None, open_timeout=30) as ws:
        await ws.send(json.dumps({
            "type": "config",
            "engine": args.engine,
            "language": args.language,
            "archive": False,
            "higgs_base_url": args.higgs_base_url,
            "voice": args.voice,
            "response_format": "pcm",
            "stream": True,
            "initial_codec_chunk_frames": args.initial_codec_chunk_frames,
            "speculative_partial_tts": True,
            "partial_first_min_chars": args.first_min_chars,
            "partial_segment_min_chars": args.segment_min_chars,
            "temperature": args.temperature,
            "max_new_tokens": args.max_new_tokens,
        }, ensure_ascii=False))

        async def send_audio() -> None:
            nonlocal marks
            await asyncio.wait_for(configured.wait(), timeout=60)
            started = time.perf_counter()
            for offset in range(0, len(stream), chunk_samples):
                if offset <= speech_sample_index < offset + chunk_samples:
                    marks["speech_sent"] = time.perf_counter()
                await ws.send(stream[offset : offset + chunk_samples].tobytes())
                target = started + min(offset + chunk_samples, len(stream)) / args.sample_rate
                await asyncio.sleep(max(0.0, target - time.perf_counter()))
            await ws.send(json.dumps({"type": "end"}))

        sender = asyncio.create_task(send_audio())
        async for raw in ws:
            if not isinstance(raw, str):
                continue
            event = json.loads(raw)
            event_type = str(event.get("type") or "")
            events.append(event_type)
            if event_type in {"partial", "final", "tts_start", "tts_chunk", "tts_done", "error"}:
                event_details.append({
                    "type": event_type,
                    "text": event.get("text"),
                    "stable_text": event.get("stable_text"),
                    "source_event": event.get("source_event"),
                    "segment_index": event.get("segment_index"),
                    "timing": event.get("timing"),
                    "message": event.get("message"),
                })
            now = time.perf_counter()
            if event_type == "configured":
                configured.set()
            elif event_type == "error":
                errors.append(str(event.get("message") or "unknown error"))
            elif event_type == "speech_start" and "vad" not in marks:
                marks["vad"] = now
            elif event_type == "partial" and event.get("text") and "partial" not in marks:
                marks["partial"] = now
                first_text = str(event.get("text") or "")
            elif event_type == "tts_start" and "tts_start" not in marks:
                marks["tts_start"] = now
                tts_segments.append({
                    "text": str(event.get("text") or ""),
                    "source_event": str(event.get("source_event") or ""),
                    "segment_index": event.get("segment_index"),
                })
            elif event_type == "tts_start":
                tts_segments.append({
                    "text": str(event.get("text") or ""),
                    "source_event": str(event.get("source_event") or ""),
                    "segment_index": event.get("segment_index"),
                })
            elif event_type == "final":
                final_texts.append(str(event.get("text") or ""))
            elif event_type == "tts_chunk":
                audio = base64.b64decode(str(event.get("audio_b64") or ""))
                duration = len(audio) / (int(event.get("sample_rate") or 24000) * 2)
                if playback_buffer_until > 0 and now > playback_buffer_until:
                    playback_underrun_s += now - playback_buffer_until
                playback_buffer_until = max(now, playback_buffer_until) + duration
                if "first_audio" not in marks:
                    marks["first_audio"] = now
                    first_audio_server = float(event.get("timing", {}).get("e2e_first_audio_sec") or 0)
            elif event_type == "tts_done":
                trimmed_silence_ms += float(event.get("trimmed_silence_ms") or 0)
                tail_silence_aborted_count += int(bool(event.get("tail_silence_aborted")))
            elif event_type == "done":
                break
        await sender

    speech_started = marks.get("speech_sent", min(marks.values(), default=time.perf_counter()))
    elapsed = {
        name: round(value - speech_started, 3)
        for name, value in marks.items()
        if name != "speech_sent"
    }
    ttfa = elapsed.get("first_audio")
    joined_tts_text = "".join(item["text"] for item in tts_segments)
    final_text = "".join(final_texts)
    speculative_segments = [item["text"] for item in tts_segments if item["source_event"] == "partial"]
    semantic_text_match = bool(final_text) and joined_tts_text == final_text
    no_micro_fragments = all(len(re.sub(r"\W", "", text)) >= args.first_min_chars for text in speculative_segments)
    return {
        "audio": str(args.audio),
        "engine": args.engine,
        "voice": args.voice,
        "first_partial_text": first_text,
        "wall_seconds_from_speech": elapsed,
        "server_e2e_first_audio_sec": round(first_audio_server, 3),
        "target_seconds": args.target_seconds,
        "target_met": ttfa is not None and ttfa <= args.target_seconds,
        "tts_segments": tts_segments,
        "tts_joined_text": joined_tts_text,
        "final_text": final_text,
        "semantic_text_match": semantic_text_match,
        "no_micro_fragments": no_micro_fragments,
        "playback_buffer_underrun_ms": round(playback_underrun_s * 1000, 1),
        "trimmed_boundary_silence_ms": round(trimmed_silence_ms, 1),
        "tail_silence_aborted_count": tail_silence_aborted_count,
        "event_count": len(events),
        "events": events,
        "event_details": event_details,
        "errors": errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("--websocket", default="ws://127.0.0.1:8000/v1/tts/higgs/stream")
    parser.add_argument("--higgs-base-url", default="http://127.0.0.1:8002")
    parser.add_argument("--engine", default="x-asr")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--voice", default="Elysia")
    parser.add_argument("--sample-rate", type=int, default=16_000)
    parser.add_argument("--chunk-ms", type=int, default=32)
    parser.add_argument("--leading-silence", type=float, default=0.4)
    parser.add_argument("--trailing-silence", type=float, default=1.2)
    parser.add_argument("--first-min-chars", type=int, default=6)
    parser.add_argument("--segment-min-chars", type=int, default=8)
    parser.add_argument("--initial-codec-chunk-frames", type=int, default=1)
    parser.add_argument("--temperature", type=float, default=0.3)
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--target-seconds", type=float, default=3.5)
    args = parser.parse_args()
    result = asyncio.run(benchmark(args))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["target_met"] or not result["semantic_text_match"] or not result["no_micro_fragments"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
