"""Actual isolated download -> integrity -> CPU ASR smoke. No live microphone/API keys."""
from __future__ import annotations

import argparse
import io
import json
import time
import wave
from pathlib import Path

import httpx


def check(response: httpx.Response):
    response.raise_for_status()
    return response.json()


def main(url: str, output: Path):
    report = {"passed": False, "checks": {}, "model": "whisper-tiny", "microphone": False}
    output.parent.mkdir(parents=True, exist_ok=True)
    project = Path(__file__).resolve().parents[2]
    try:
        with httpx.Client(base_url=url, timeout=30) as client:
            catalog = check(client.get('/v1/model-downloads/catalog'))
            model = next(row for row in catalog['models'] if row['id'] == 'whisper-tiny')
            # Never replace an existing user model or operate a non-QA backend.
            if 'model-download-preview' not in model['weights']['path']:
                raise RuntimeError('Only the isolated download-preview backend may be tested.')
            report['checks']['catalog'] = {'models': len(catalog['models']), 'path': model['weights']['path']}
            started = time.monotonic()
            check(client.post('/v1/model-downloads/whisper-tiny/start', json={'region': 'mainland', 'source': 'auto'}))
            paused = False
            history = []
            last = None
            while time.monotonic() - started < 900:
                rows = check(client.get('/v1/model-downloads/status'))['jobs']
                job = next(row for row in rows if row['id'] == 'whisper-tiny')
                display = (job['status'], job.get('source'), job.get('current_file'))
                if display != last:
                    print(json.dumps({'status': display[0], 'source': display[1], 'file': display[2]}, ensure_ascii=False), flush=True)
                    history.append({'status': display[0], 'source': display[1], 'file': display[2]})
                    last = display
                if job['status'] == 'error':
                    raise RuntimeError(job.get('error') or 'Download failed')
                if not paused and job['status'] == 'downloading' and job['downloaded_bytes'] > 1024 * 1024:
                    cancelled = check(client.post('/v1/model-downloads/whisper-tiny/cancel'))
                    if cancelled['status'] == 'cancelled':
                        partial_catalog = check(client.get('/v1/model-downloads/catalog'))
                        item = next(row for row in partial_catalog['models'] if row['id'] == 'whisper-tiny')
                        if item['weights']['status'] == 'ready':
                            raise RuntimeError('Incomplete download incorrectly reported ready')
                        report['checks']['pause'] = {'bytes': cancelled['downloaded_bytes'], 'ready': False}
                    check(client.post('/v1/model-downloads/whisper-tiny/start', json={'region': 'mainland', 'source': 'auto'}))
                    paused = True
                if job['status'] == 'completed':
                    report['checks']['download'] = {'seconds': round(time.monotonic() - started, 2), 'bytes': job['downloaded_bytes'], 'source': job.get('source'), 'history': history}
                    break
                time.sleep(.15)
            else:
                raise RuntimeError('Download exceeded 15 minutes')
            catalog = check(client.get('/v1/model-downloads/catalog'))
            model = next(row for row in catalog['models'] if row['id'] == 'whisper-tiny')
            if model['weights']['status'] != 'ready' or not model['weights']['verified']:
                raise RuntimeError('Completed model is not verified')
            if not model['runtime']['installed']:
                raise RuntimeError(f"Whisper runtime missing: {model['runtime']}")
            loaded = check(client.post('/v1/models/whisper/load', json={'model_name': 'tiny', 'device': 'cpu', 'compute_type': 'int8', 'extra': {'model_dir': model['weights']['path']}}, timeout=120))
            if not loaded['is_loaded']:
                raise RuntimeError('Downloaded model did not load')
            report['checks']['load'] = {'device': loaded['device'], 'is_loaded': loaded['is_loaded']}
            pcm = (project / 'frontend/desktop/public/pet/speech-preview.pcm').read_bytes()
            audio = io.BytesIO()
            with wave.open(audio, 'wb') as stream:
                stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(24000); stream.writeframes(pcm)
            before = time.monotonic()
            transcript = check(client.post('/v1/transcribe', files={'file': ('fixture.wav', audio.getvalue(), 'audio/wav')}, data={'options': json.dumps({'engine': 'whisper', 'language': 'zh', 'whisper_model': 'tiny', 'timeout_sec': 120, 'enable_punctuation': False, 'enable_hotwords': False})}, timeout=150))
            if transcript.get('status') != 'success' or not transcript.get('full_text', '').strip():
                raise RuntimeError('CPU ASR did not return a transcript')
            report['checks']['transcribe'] = {'seconds': round(time.monotonic() - before, 2), 'status': transcript['status'], 'text': transcript['full_text'], 'note': 'Synthetic speech fixture; functional check, not an accuracy benchmark.'}
            check(client.post('/v1/models/whisper/unload'))
            report['passed'] = True
    except Exception as exc:
        report['error'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', type=Path, default=Path('.runtime/model-download-preview/download-report.json'))
    args = parser.parse_args()
    main(args.url, args.output)
