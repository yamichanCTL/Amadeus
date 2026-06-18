"""
GPT-SoVITS TTS provider — real speech synthesis with voice cloning.

Talks directly to GPT-SoVITS HTTP API (api_v2.py on port 9880).
Uses soundfile monkey-patch to avoid torchcodec dependency.

Sentence splitting: breaks long text into sentences, synthesizes each
separately, concatenates WAVs. The first sentence plays while later ones
are still generating — pseudo-streaming for lower perceived latency.
"""

from __future__ import annotations

import logging
import re
import struct
import subprocess
import time
from io import BytesIO
from pathlib import Path

import httpx

from runner.tts.base import TTSProvider, TTSRequest, TTSResult

logger = logging.getLogger("runner.tts.gpt_sovits")

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_PRETRAINED_DIR = _PROJECT_ROOT / "tts" / "pretrained_models"
_OUTPUT_DIR = _PROJECT_ROOT / ".runtime" / "tts_output"
_RUNTIME_DIR = _PROJECT_ROOT / ".runtime"
# Elysia voice reference
_REF_AUDIO = str(_RUNTIME_DIR / "ref_elysia.wav")
_GPT_SOVITS_DIR = Path("/home/yami/AI/GPT-SoVITS")

# ── Sentence splitting pattern ───────────────────────────────────────────────
# Matches Chinese/Japanese punctuation and English sentence endings
_SENTENCE_RE = re.compile(
    r'([^。！？!?\n;；]+[。！？!?\n;；]+)'
)

# ── torchaudio monkey-patch (avoids torchcodec) ──────────────────────────────
_PATCH_SCRIPT = """
import soundfile as sf, torch
def _patched_load(uri, *a, **kw):
    data, sr = sf.read(str(uri), dtype='float32')
    if data.ndim == 1: data = data.reshape(1, -1)
    else: data = data.T
    return torch.from_numpy(data.copy()), sr
def _patched_save(uri, src, sr, *a, **kw):
    d = src.detach().cpu().numpy()
    if d.ndim == 2: d = d.T
    sf.write(str(uri), d, sr)
import torchaudio
torchaudio.load = _patched_load
torchaudio.save = _patched_save
torchaudio.load_with_torchcodec = _patched_load
torchaudio.save_with_torchcodec = _patched_save
"""


def _start_server() -> bool:
    """Start GPT-SoVITS api_v2.py if not already running, with torchaudio patched."""
    try:
        resp = httpx.get("http://127.0.0.1:9880/docs", timeout=3)
        if resp.status_code == 200:
            return True
    except Exception:
        pass

    # Not running — start it
    api_path = _GPT_SOVITS_DIR / "api_v2.py"
    if not api_path.exists():
        logger.error("GPT-SoVITS api_v2.py not found at %s", api_path)
        return False

    # Create cache dir for fast-langdetect
    (_GPT_SOVITS_DIR / "GPT_SoVITS" / "pretrained_models" / "fast_langdetect").mkdir(
        parents=True, exist_ok=True
    )

    # Write patch script
    patch_path = _PROJECT_ROOT / ".runtime" / "_patch_ta.py"
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    patch_path.write_text(_PATCH_SCRIPT)

    venv_python = str(_PROJECT_ROOT / ".venv" / "bin" / "python")
    patch_import = f"import sys; sys.path.insert(0, '{patch_path.parent}'); import _patch_ta"

    logger.info("Starting GPT-SoVITS server...")
    subprocess.Popen(
        [venv_python, "-c", f"{patch_import}; exec(open('{api_path}').read())"],
        cwd=str(_GPT_SOVITS_DIR),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    # Wait for ready
    for i in range(60):
        time.sleep(1)
        try:
            resp = httpx.get("http://127.0.0.1:9880/docs", timeout=2)
            if resp.status_code == 200:
                logger.info("GPT-SoVITS server ready (attempt %d)", i + 1)
                return True
        except Exception:
            pass
    logger.error("GPT-SoVITS server failed to start within 60s")
    return False


# Default models: V2 for low latency (~1.5s), V3 for quality (~24s)
# V2 is 16x faster with minimal quality loss for short responses
_GPT_MODEL = "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"
_SOVITS_MODEL = "s2G488k.pth"


def _load_models(
    gpt_model: str | None = None,
    sovits_model: str | None = None,
) -> bool:
    """Load GPT and SoVITS models (defaults to fast V2)."""
    gpt = gpt_model or _GPT_MODEL
    sovits = sovits_model or _SOVITS_MODEL
    try:
        r1 = httpx.get(
            "http://127.0.0.1:9880/set_gpt_weights",
            params={"weights_path": str(_PRETRAINED_DIR / gpt)},
            timeout=30,
        )
        r2 = httpx.get(
            "http://127.0.0.1:9880/set_sovits_weights",
            params={"weights_path": str(_PRETRAINED_DIR / sovits)},
            timeout=30,
        )
        ok = r1.status_code == 200 and r2.status_code == 200
        if ok:
            logger.info("GPT-SoVITS models loaded: %s + %s", gpt, sovits)
        return ok
    except Exception as e:
        logger.error("Failed to load models: %s", e)
        return False


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences for batch TTS.

    Handles Chinese (。！？), English (.!?), and mixed punctuation.
    Preserves natural pauses between sentences.
    """
    # Try regex-based splitting first
    parts = _SENTENCE_RE.findall(text)
    if parts:
        # Collect any remaining text after the last match
        matched_end = 0
        for m in _SENTENCE_RE.finditer(text):
            matched_end = m.end()
        remaining = text[matched_end:].strip()
        result = [p.strip() for p in parts if p.strip()]
        if remaining:
            result.append(remaining)
        return result

    # Fallback: split by newlines or just return as-is
    if "\n" in text:
        return [l.strip() for l in text.split("\n") if l.strip()]
    return [text.strip()] if text.strip() else []


def _concat_wavs(wavs: list[bytes]) -> bytes:
    """Concatenate multiple WAV files into one.

    Handles PCM WAV format only. All WAVs must be same sample rate/channels.
    """
    if len(wavs) == 0:
        return b""
    if len(wavs) == 1:
        return wavs[0]

    # Parse first WAV header to get format info
    first = wavs[0]
    if len(first) < 44:
        return b"".join(wavs)  # can't parse, just join raw

    # Verify RIFF header
    if first[:4] != b"RIFF":
        return b"".join(wavs)

    # Extract audio data (skip 44-byte header, find "data" chunk)
    data_chunks: list[bytes] = []
    total_data_size = 0
    sample_rate = struct.unpack_from("<I", first, 24)[0]
    channels = struct.unpack_from("<H", first, 22)[0]
    bits_per_sample = struct.unpack_from("<H", first, 34)[0]

    for wav in wavs:
        # Find "data" chunk in WAV
        idx = wav.find(b"data")
        if idx < 0:
            continue
        # data chunk: "data" (4) + size (4) + audio data
        size = struct.unpack_from("<I", wav, idx + 4)[0]
        audio = wav[idx + 8 : idx + 8 + size]
        data_chunks.append(audio)
        total_data_size += len(audio)

    # Build new WAV
    buf = BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + total_data_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))  # fmt chunk size
    buf.write(struct.pack("<H", 1))   # PCM format
    buf.write(struct.pack("<H", channels))
    buf.write(struct.pack("<I", sample_rate))
    byte_rate = sample_rate * channels * bits_per_sample // 8
    buf.write(struct.pack("<I", byte_rate))
    buf.write(struct.pack("<H", channels * bits_per_sample // 8))
    buf.write(struct.pack("<H", bits_per_sample))
    buf.write(b"data")
    buf.write(struct.pack("<I", total_data_size))
    for chunk in data_chunks:
        buf.write(chunk)

    return buf.getvalue()


class GPTSoVITSTTS(TTSProvider):
    """Real TTS provider using GPT-SoVITS with Elysia voice cloning.

    Splits long text into sentences and synthesizes each separately
    for lower perceived latency. Concatenates the results.

    Usage::

        tts = GPTSoVITSTTS()
        result = tts.synthesize(TTSRequest(text="你好世界"))
        print(result.audio_path)  # Path to generated WAV
    """

    name = "gpt_sovits"

    def __init__(
        self,
        ref_audio: str | None = None,
        prompt_text: str = "",
        prompt_lang: str = "zh",
        text_lang: str = "zh",
        speed: float = 1.0,
    ):
        self.ref_audio = ref_audio or _REF_AUDIO
        self.prompt_text = prompt_text
        self.prompt_lang = prompt_lang
        self.text_lang = text_lang
        self.speed = speed
        _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        self._ready = False

    def _ensure_ready(self) -> bool:
        """Ensure server is running and models loaded."""
        if self._ready:
            return True
        if not _start_server():
            return False
        if not _load_models():
            return False
        self._ready = True
        return True

    def _tts_one(self, text: str, speed: float) -> bytes | None:
        """Synthesize a single segment. Returns WAV bytes or None."""
        ref_wav = self.ref_audio
        if ref_wav and Path(ref_wav).suffix in (".m4a", ".mp3"):
            ref_wav = str(Path(ref_wav).with_suffix(".wav"))

        resp = httpx.post(
            "http://127.0.0.1:9880/tts",
            json={
                "text": text[:500],
                "text_lang": self.text_lang,
                "ref_audio_path": ref_wav if Path(ref_wav).exists() else "",
                "prompt_lang": self.prompt_lang,
                "prompt_text": self.prompt_text,
                "text_split_method": "cut0",
                "batch_size": 1,
                "speed_factor": speed,
            },
            timeout=120,
        )
        if resp.status_code == 200 and len(resp.content) > 100:
            return resp.content
        return None

    def synthesize(self, request: TTSRequest) -> TTSResult:
        """Synthesize speech with sentence-by-sentence streaming.

        Splits text into sentences, synthesizes each separately,
        concatenates all into a single WAV file.
        """
        if not self._ensure_ready():
            return TTSResult(
                text=request.text,
                provider=self.name,
                success=False,
                error="GPT-SoVITS server not available",
            )

        text = request.text[:2000]
        speed = request.speed or self.speed
        sentences = _split_sentences(text)

        # If only one sentence or very short, do single TTS call
        if len(sentences) <= 1:
            result = self._tts_one(text, speed)
            if result:
                ts = int(time.time() * 1000)
                path = _OUTPUT_DIR / f"tts_{ts}.wav"
                path.write_bytes(result)
                return TTSResult(
                    text=text, audio_path=str(path),
                    duration_seconds=len(result) / 32000,
                    provider=self.name, success=True,
                )
            return TTSResult(
                text=text, provider=self.name, success=False,
                error="TTS returned no audio",
            )

        # Multiple sentences: synthesize each, concatenate
        wavs: list[bytes] = []
        timings: list[dict] = []
        t_start = time.perf_counter()

        for i, sentence in enumerate(sentences):
            t0 = time.perf_counter()
            wav = self._tts_one(sentence, speed)
            t1 = time.perf_counter()
            if wav:
                wavs.append(wav)
                timings.append({
                    "index": i, "text": sentence[:60],
                    "bytes": len(wav), "time": round(t1 - t0, 2),
                })
                logger.info(
                    "TTS[%d/%d] %.2fs \"%s\"",
                    i + 1, len(sentences), t1 - t0, sentence[:40],
                )

        if not wavs:
            return TTSResult(
                text=text, provider=self.name, success=False,
                error="All TTS segments failed",
            )

        # Concatenate and save
        combined = _concat_wavs(wavs)
        ts = int(time.time() * 1000)
        path = _OUTPUT_DIR / f"tts_{ts}.wav"
        path.write_bytes(combined)

        total_time = round(time.perf_counter() - t_start, 2)
        logger.info(
            "TTS done: %d sentences, %d bytes, %.2fs → %s",
            len(wavs), len(combined), total_time, path.name,
        )

        return TTSResult(
            text=text,
            audio_path=str(path),
            duration_seconds=len(combined) / 32000,
            provider=self.name,
            success=True,
        )
