"""X-ASR-zh-en true streaming adapter backed by sherpa-onnx."""

from __future__ import annotations

import asyncio
import io
import ctypes
import os
import re
import threading
from pathlib import Path
from typing import Any, Callable

_SYSTEM_LIBSTDCPP = Path("/usr/lib/x86_64-linux-gnu/libstdc++.so.6")
if _SYSTEM_LIBSTDCPP.is_file():
    # The project venv uses the Miniconda Python executable. Its bundled
    # libstdc++ is older than the official sherpa CUDA wheel, so load the
    # newer system ABI before numpy/onnxruntime can bind the old SONAME.
    ctypes.CDLL(str(_SYSTEM_LIBSTDCPP), mode=ctypes.RTLD_GLOBAL)

import numpy as np
import soundfile as sf
from app.config import get_settings
from app.core.asr.base import (
    ASRResult,
    BaseASREngine,
    BaseStreamingASRSession,
    EngineOptions,
    Segment,
)
from app.core.model_errors import classify_model_error

settings = get_settings()
_SAMPLE_RATE = 16_000
_CJK_RANGE = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
_CJK_PUNCT = re.escape("，。！？；：、（）《》〈〉【】「」『』“”‘’")
_ASCII_PUNCT = re.escape(",.!?;:%)]}")
X_ASR_VARIANTS = (160, 480, 960, 1920)
X_ASR_MODEL_NAMES = tuple(f"chunk-{chunk_ms}ms-model" for chunk_ms in X_ASR_VARIANTS)


class XASREngine(BaseASREngine):
    """Released X-ASR Zipformer transducer with persistent online state."""

    ENGINE_NAME = "x-asr"

    def __init__(
        self,
        model_name: str | None = None,
        model_dir: str | None = None,
        device: str | None = None,
        provider: str | None = None,
        num_threads: int | None = None,
        text_format: str | None = None,
        **_: Any,
    ) -> None:
        self._model_name = model_name or settings.default_x_asr_model
        configured_dir = Path(model_dir) if model_dir else settings.x_asr_model_dir
        if not model_dir and model_name in X_ASR_MODEL_NAMES:
            configured_dir = settings.x_asr_model_dir.parent / model_name
        if model_name and ("/" in model_name or model_name.startswith(".")):
            configured_dir = Path(model_name)
        self._model_dir = configured_dir.expanduser().resolve()
        requested_provider = provider or device or settings.default_x_asr_provider
        self._provider = "cuda" if str(requested_provider).startswith("cuda") else "cpu"
        self._num_threads = num_threads or settings.x_asr_num_threads
        self._text_format = text_format or settings.x_asr_text_format
        self._recognizer: Any = None
        self._decode_lock = threading.RLock()

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    @property
    def supports_streaming(self) -> bool:
        return True

    async def load(self) -> None:
        if self._recognizer is not None:
            return
        paths = self._model_paths()
        self._validate_model_paths(paths)
        try:
            import sherpa_onnx  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                "X-ASR requires sherpa-onnx. Install with: pip install 'asr-backend[sherpa]'"
            ) from exc
        runtime_version = str(getattr(sherpa_onnx, "__version__", "unknown"))
        if self._provider == "cuda" and "+cuda" not in runtime_version:
            raise RuntimeError(
                "X-ASR requested CUDA, but the installed sherpa-onnx "
                f"{runtime_version} is CPU-only. Install an official '+cuda' wheel; "
                "CPU fallback is disabled so the UI cannot report a false CUDA load."
            )
        if self._provider == "cuda":
            _preload_cuda_libraries(settings.x_asr_cuda_library_path)

        def build() -> Any:
            recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=str(paths["tokens"]),
                encoder=str(paths["encoder"]),
                decoder=str(paths["decoder"]),
                joiner=str(paths["joiner"]),
                num_threads=self._num_threads,
                sample_rate=_SAMPLE_RATE,
                feature_dim=80,
                decoding_method="greedy_search",
                provider=self._provider,
                model_type="zipformer2",
                enable_endpoint_detection=False,
            )
            if self._provider == "cuda":
                # Keep CUDA construction and warm-up on the same worker in
                # case the native runtime uses thread-local CUDA state.
                _warm_up_recognizer(recognizer, self._chunk_ms())
            return recognizer

        try:
            if self._provider == "cuda":
                # CUDA initialisation and the first real decode are both
                # blocking native calls. Warm up off the event loop so the
                # WebSocket can continue sending loading heartbeats.
                recognizer = await asyncio.to_thread(build)
            else:
                recognizer = build()
        except Exception as exc:
            self._recognizer = None
            raise classify_model_error(exc, self.ENGINE_NAME) from exc
        # A recognizer is only considered loaded after CUDA warm-up succeeds.
        self._recognizer = recognizer

    async def unload(self) -> None:
        self._recognizer = None

    @property
    def is_loaded(self) -> bool:
        return self._recognizer is not None

    async def create_streaming_session(
        self,
        sample_rate: int = _SAMPLE_RATE,
        options: EngineOptions | None = None,
    ) -> BaseStreamingASRSession:
        if sample_rate != _SAMPLE_RATE:
            raise ValueError(f"X-ASR expects {_SAMPLE_RATE} Hz PCM, got {sample_rate} Hz")
        if not self.is_loaded:
            await self.load()
        assert self._recognizer is not None
        return _XASRStreamingSession(
            recognizer=self._recognizer,
            decode_lock=self._decode_lock,
            text_format=self._text_format,
            language=(options.language if options else None),
            run_in_worker=self._provider == "cuda",
            on_runtime_failure=self._mark_runtime_failed,
        )

    async def transcribe(
        self,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        audio = _decode_audio(audio_bytes)
        stream = await self.create_streaming_session(_SAMPLE_RATE, options)
        chunk_samples = int(_SAMPLE_RATE * self._chunk_ms() / 1000)
        for start in range(0, len(audio), chunk_samples):
            chunk = audio[start : start + chunk_samples]
            pcm = np.clip(chunk * 32768.0, -32768, 32767).astype("<i2").tobytes()
            await stream.accept_pcm(pcm)
        return await stream.finish()

    def info(self) -> dict[str, Any]:
        base = super().info()
        paths = self._model_paths()
        base.update(
            {
                "model_name": self._model_name,
                "device": self._provider,
                "model_dir": str(self._model_dir),
                "languages": ["zh", "en"],
                "chunk_ms": self._chunk_ms(),
                "model_variants": list(X_ASR_MODEL_NAMES),
                "available_variants": [
                    name
                    for name in X_ASR_MODEL_NAMES
                    if self._variant_available(name)
                ],
                "model_repository": "GilgameshWind/X-ASR-zh-en",
                "num_threads": self._num_threads,
                "text_format": self._text_format,
                "model_available": all(
                    path.is_file() and path.stat().st_size > 1024
                    for path in paths.values()
                ),
                "runtime": "sherpa-onnx",
                "runtime_version": _sherpa_version(),
                "cuda_runtime": "+cuda" in _sherpa_version(),
                "cuda_library_path": settings.x_asr_cuda_library_path,
            }
        )
        return base

    def _model_paths(self) -> dict[str, Path]:
        chunk_ms = str(self._chunk_ms())
        return {
            "tokens": self._model_dir / "tokens.txt",
            "encoder": self._model_dir / f"encoder-{chunk_ms}ms.onnx",
            "decoder": self._model_dir / f"decoder-{chunk_ms}ms.onnx",
            "joiner": self._model_dir / f"joiner-{chunk_ms}ms.onnx",
        }

    def _chunk_ms(self) -> int:
        suffix_match = re.search(r"chunk-(\d+)ms", self._model_dir.name)
        return int(suffix_match.group(1)) if suffix_match else 160

    def _variant_available(self, model_name: str) -> bool:
        model_dir = settings.x_asr_model_dir.parent / model_name
        match = re.search(r"chunk-(\d+)ms", model_name)
        if not match:
            return False
        suffix = match.group(1)
        paths = (
            model_dir / "tokens.txt",
            model_dir / f"encoder-{suffix}ms.onnx",
            model_dir / f"decoder-{suffix}ms.onnx",
            model_dir / f"joiner-{suffix}ms.onnx",
        )
        return all(path.is_file() and path.stat().st_size > 1024 for path in paths)

    def _validate_model_paths(self, paths: dict[str, Path]) -> None:
        missing = [str(path) for path in paths.values() if not path.is_file()]
        if missing:
            raise RuntimeError(
                "X-ASR model files are missing: "
                + ", ".join(missing)
                + ". Download the matching model folder from Hugging Face "
                "GilgameshWind/X-ASR-zh-en; files from different windows cannot be mixed."
            )
        pointers = [str(path) for path in paths.values() if _is_lfs_pointer(path)]
        if pointers:
            raise RuntimeError(
                "X-ASR model files are Git LFS pointers, not model data: "
                + ", ".join(pointers)
            )

    def _mark_runtime_failed(self) -> None:
        # Do not keep reporting a poisoned native recognizer as loaded. The
        # manager will retry load/warm-up on the next explicit request.
        self._recognizer = None


class _XASRStreamingSession(BaseStreamingASRSession):
    def __init__(
        self,
        recognizer: Any,
        decode_lock: threading.RLock,
        text_format: str,
        language: str | None,
        run_in_worker: bool,
        on_runtime_failure: Callable[[], None],
    ) -> None:
        self._recognizer = recognizer
        self._decode_lock = decode_lock
        self._stream = recognizer.create_stream()
        self._text_format = text_format
        self._language = language if language not in {None, "auto"} else None
        self._run_in_worker = run_in_worker
        self._on_runtime_failure = on_runtime_failure
        self._last_text = ""
        self._samples = 0
        self._finished = False

    async def accept_pcm(self, pcm_bytes: bytes) -> ASRResult | None:
        if self._finished:
            raise RuntimeError("X-ASR streaming session is already finished")
        if len(pcm_bytes) % 2:
            pcm_bytes = pcm_bytes[:-1]
        if not pcm_bytes:
            return None
        samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
        self._samples += len(samples)
        try:
            if self._run_in_worker:
                text = await asyncio.to_thread(self._accept_sync, samples)
            else:
                text = self._accept_sync(samples)
        except Exception as exc:
            self._on_runtime_failure()
            raise classify_model_error(exc, "x-asr") from exc
        if text == self._last_text:
            return None
        self._last_text = text
        return self._result(text, is_final=False)

    async def finish(self) -> ASRResult:
        if not self._finished:
            self._finished = True
            try:
                if self._run_in_worker:
                    text = await asyncio.to_thread(self._finish_sync)
                else:
                    text = self._finish_sync()
            except Exception as exc:
                self._on_runtime_failure()
                raise classify_model_error(exc, "x-asr") from exc
            self._last_text = text
        return self._result(self._last_text, is_final=True)

    def _accept_sync(self, samples: np.ndarray) -> str:
        with self._decode_lock:
            self._stream.accept_waveform(_SAMPLE_RATE, samples)
            while self._recognizer.is_ready(self._stream):
                self._recognizer.decode_stream(self._stream)
            return _format_text(self._recognizer.get_result(self._stream), self._text_format)

    def _finish_sync(self) -> str:
        with self._decode_lock:
            self._stream.input_finished()
            while self._recognizer.is_ready(self._stream):
                self._recognizer.decode_stream(self._stream)
            return _format_text(self._recognizer.get_result(self._stream), self._text_format)

    def _result(self, text: str, is_final: bool) -> ASRResult:
        duration = self._samples / _SAMPLE_RATE
        return ASRResult(
            full_text=text,
            segments=[Segment(start=0.0, end=duration, text=text)] if text else [],
            language=self._language,
            engine_name="x-asr",
            raw={"is_final": is_final, "duration_sec": duration, "streaming": True},
        )


def _decode_audio(audio_bytes: bytes) -> np.ndarray:
    audio, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if sample_rate != _SAMPLE_RATE:
        import librosa  # type: ignore[import-not-found]

        mono = librosa.resample(mono, orig_sr=sample_rate, target_sr=_SAMPLE_RATE)
    return np.ascontiguousarray(mono, dtype=np.float32)


def _format_text(text: str, mode: str) -> str:
    if mode == "lower":
        text = text.lower()
    elif mode == "capitalize" and text:
        text = text[:1].upper() + text[1:].lower()
    text = re.sub(rf"(?<=[{_CJK_RANGE}])\s+(?=[{_CJK_RANGE}{_CJK_PUNCT}])", "", text)
    text = re.sub(rf"(?<=[{_CJK_PUNCT}])\s+(?=[{_CJK_RANGE}{_CJK_PUNCT}])", "", text)
    return re.sub(rf"\s+(?=[{_ASCII_PUNCT}])", "", text).strip()


def _is_lfs_pointer(path: Path) -> bool:
    if path.suffix != ".onnx" or path.stat().st_size > 1024:
        return False
    return path.read_bytes().startswith(b"version https://git-lfs.github.com/spec/v1")


def _sherpa_version() -> str:
    try:
        import sherpa_onnx  # type: ignore[import-not-found]
        return str(getattr(sherpa_onnx, "__version__", "unknown"))
    except ImportError:
        return "not-installed"


def _warm_up_recognizer(recognizer: Any, chunk_ms: int) -> None:
    """Force one native decode so CUDA/OOM failures happen during load."""

    stream = recognizer.create_stream()
    sample_count = max(1, int(_SAMPLE_RATE * max(chunk_ms, 160) / 1000))
    stream.accept_waveform(_SAMPLE_RATE, np.zeros(sample_count, dtype=np.float32))
    _drain_ready_stream(recognizer, stream)
    stream.input_finished()
    _drain_ready_stream(recognizer, stream)
    recognizer.get_result(stream)


def _drain_ready_stream(recognizer: Any, stream: Any) -> None:
    for _ in range(1024):
        if not recognizer.is_ready(stream):
            return
        recognizer.decode_stream(stream)
    raise RuntimeError("X-ASR warm-up decoder did not become idle")


def _preload_cuda_libraries(configured_root: str) -> None:
    roots: list[Path] = []
    if configured_root.strip():
        roots.extend(Path(item).expanduser() for item in configured_root.split(os.pathsep) if item.strip())
    roots.extend([
        Path(os.sys.prefix) / f"lib/python{os.sys.version_info.major}.{os.sys.version_info.minor}/site-packages/nvidia",
        Path("/usr/local/cuda/lib64"),
    ])
    required = (
        "libcudart.so.12",
        "libcublasLt.so.12",
        "libcublas.so.12",
        "libcurand.so.10",
        "libcufft.so.11",
        "libcudnn.so.9",
    )
    loaded: set[str] = set()
    for soname in required:
        for root in roots:
            if not root.exists():
                continue
            matches = list(root.rglob(soname)) if root.is_dir() else []
            if not matches:
                continue
            try:
                ctypes.CDLL(str(matches[0]), mode=ctypes.RTLD_GLOBAL)
                loaded.add(soname)
                break
            except OSError:
                continue
    missing = [soname for soname in required if soname not in loaded]
    if missing:
        raise RuntimeError(
            "X-ASR CUDA runtime libraries are missing: "
            + ", ".join(missing)
            + ". Set X_ASR_CUDA_LIBRARY_PATH to the directory containing NVIDIA runtime libraries."
        )
