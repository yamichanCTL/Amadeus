"""X-ASR-zh-en true streaming adapter backed by sherpa-onnx."""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import importlib.metadata
import io
import multiprocessing
import os
import re
import threading
import traceback
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

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
_SPAWN_ENV_LOCK = threading.RLock()


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
        self._worker: _XASRWorkerClient | None = None
        self._decode_lock = threading.RLock()

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    @property
    def supports_streaming(self) -> bool:
        return True

    async def load(self) -> None:
        if self.is_loaded:
            return
        paths = self._model_paths()
        self._validate_model_paths(paths)
        if self._provider == "cuda" and settings.x_asr_isolate_cuda:
            worker = _XASRWorkerClient(
                paths=paths,
                num_threads=self._num_threads,
                chunk_ms=self._chunk_ms(),
                cuda_roots=settings.x_asr_cuda_library_roots(),
                libstdcpp_path=settings.x_asr_libstdcpp_path,
                timeout_sec=settings.x_asr_worker_timeout_sec,
            )
            try:
                await asyncio.to_thread(worker.start)
            except Exception as exc:
                worker.close()
                raise classify_model_error(exc, self.ENGINE_NAME) from exc
            self._worker = worker
            return
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
            _preload_cuda_libraries(
                settings.x_asr_cuda_library_roots(),
                settings.x_asr_libstdcpp_path,
            )

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
        worker, self._worker = self._worker, None
        if worker is not None:
            await asyncio.to_thread(worker.close)
        self._recognizer = None

    @property
    def is_loaded(self) -> bool:
        return self._worker is not None or self._recognizer is not None

    async def create_streaming_session(
        self,
        sample_rate: int = _SAMPLE_RATE,
        options: EngineOptions | None = None,
    ) -> BaseStreamingASRSession:
        if sample_rate != _SAMPLE_RATE:
            raise ValueError(f"X-ASR expects {_SAMPLE_RATE} Hz PCM, got {sample_rate} Hz")
        if not self.is_loaded:
            await self.load()
        if self._worker is not None:
            stream_id = await asyncio.to_thread(self._worker.create_stream)
            return _XASRWorkerStreamingSession(
                worker=self._worker,
                stream_id=stream_id,
                text_format=self._text_format,
                language=(options.language if options else None),
                on_runtime_failure=self._mark_runtime_failed,
            )
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
                "runtime_version": self._runtime_version(),
                "cuda_runtime": "+cuda" in self._runtime_version(),
                "cuda_library_path": settings.x_asr_cuda_library_path,
                "cuda_isolated": self._provider == "cuda" and settings.x_asr_isolate_cuda,
                "worker_pid": self._worker.pid if self._worker is not None else None,
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
        worker, self._worker = self._worker, None
        if worker is not None:
            worker.close()

    def _runtime_version(self) -> str:
        if self._worker is not None:
            return self._worker.runtime_version
        return _sherpa_version(import_runtime=not settings.x_asr_isolate_cuda)


class _XASRWorkerClient:
    """Own a clean spawned process for the CUDA 12 sherpa runtime."""

    def __init__(
        self,
        paths: dict[str, Path],
        num_threads: int,
        chunk_ms: int,
        cuda_roots: tuple[Path, ...],
        libstdcpp_path: Path | None,
        timeout_sec: int,
    ) -> None:
        self._config = {
            "paths": {name: str(path) for name, path in paths.items()},
            "num_threads": num_threads,
            "chunk_ms": chunk_ms,
            "cuda_roots": [str(path) for path in cuda_roots],
            "libstdcpp_path": str(libstdcpp_path) if libstdcpp_path else None,
        }
        self._timeout_sec = max(5, timeout_sec)
        self._lock = threading.RLock()
        self._connection: Any = None
        self._process: Any = None
        self.runtime_version = "not-started"

    @property
    def pid(self) -> int | None:
        return self._process.pid if self._process is not None else None

    def start(self) -> None:
        if self._process is not None and self._process.is_alive():
            return
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe()
        process = context.Process(
            target=_x_asr_worker_main,
            args=(child, self._config),
            name="x-asr-cuda-worker",
            daemon=True,
        )
        # multiprocessing's spawn mode execs the current Python interpreter.
        # Supply ABI/runtime paths before that exec: loading libstdc++ later via
        # ctypes cannot replace Miniconda's older copy once it is already bound.
        with _SPAWN_ENV_LOCK:
            original_preload = os.environ.get("LD_PRELOAD")
            original_library_path = os.environ.get("LD_LIBRARY_PATH")
            try:
                if self._config["libstdcpp_path"]:
                    os.environ["LD_PRELOAD"] = os.pathsep.join(
                        item
                        for item in (self._config["libstdcpp_path"], original_preload)
                        if item
                    )
                cuda_dirs = _cuda_library_directories(
                    tuple(Path(item) for item in self._config["cuda_roots"])
                )
                if cuda_dirs:
                    library_paths = [str(path) for path in cuda_dirs]
                    if original_library_path:
                        library_paths.append(original_library_path)
                    os.environ["LD_LIBRARY_PATH"] = os.pathsep.join(
                        library_paths
                    )
                process.start()
            finally:
                if original_preload is None:
                    os.environ.pop("LD_PRELOAD", None)
                else:
                    os.environ["LD_PRELOAD"] = original_preload
                if original_library_path is None:
                    os.environ.pop("LD_LIBRARY_PATH", None)
                else:
                    os.environ["LD_LIBRARY_PATH"] = original_library_path
        child.close()
        self._connection = parent
        self._process = process
        response = self._receive("启动", self._timeout_sec)
        if response.get("status") != "ready":
            error = response.get("error", "X-ASR CUDA worker failed to start")
            self.close(force=True)
            raise RuntimeError(error)
        self.runtime_version = str(response.get("runtime_version", "unknown"))

    def create_stream(self) -> str:
        return str(self._request("create_stream")["stream_id"])

    def accept_pcm(self, stream_id: str, pcm_bytes: bytes) -> str:
        return str(self._request("accept", stream_id=stream_id, pcm=pcm_bytes).get("text", ""))

    def finish(self, stream_id: str) -> str:
        return str(self._request("finish", stream_id=stream_id).get("text", ""))

    def close(self, force: bool = False) -> None:
        with self._lock:
            connection, process = self._connection, self._process
            self._connection = None
            self._process = None
            if connection is not None and process is not None and process.is_alive() and not force:
                try:
                    connection.send({"command": "shutdown"})
                    if connection.poll(2):
                        connection.recv()
                except (BrokenPipeError, EOFError, OSError):
                    pass
            if connection is not None:
                connection.close()
            if process is not None:
                process.join(timeout=2)
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=2)

    def _request(self, command: str, **payload: Any) -> dict[str, Any]:
        with self._lock:
            if self._connection is None or self._process is None or not self._process.is_alive():
                raise RuntimeError("X-ASR CUDA worker is not running")
            try:
                self._connection.send({"command": command, **payload})
            except (BrokenPipeError, EOFError, OSError) as exc:
                raise RuntimeError("X-ASR CUDA worker connection was lost") from exc
            response = self._receive(command, self._timeout_sec)
            if response.get("status") != "ok":
                raise RuntimeError(str(response.get("error", f"X-ASR worker {command} failed")))
            return response

    def _receive(self, operation: str, timeout_sec: int) -> dict[str, Any]:
        if self._connection is None or self._process is None:
            raise RuntimeError("X-ASR CUDA worker is not initialized")
        if not self._connection.poll(timeout_sec):
            if not self._process.is_alive():
                raise RuntimeError(
                    "X-ASR CUDA worker exited during "
                    f"{operation} (exit code {self._process.exitcode})"
                )
            raise TimeoutError(f"X-ASR CUDA worker {operation} timed out after {timeout_sec}s")
        try:
            return dict(self._connection.recv())
        except EOFError as exc:
            raise RuntimeError("X-ASR CUDA worker closed its connection") from exc


def _x_asr_worker_main(connection: Any, config: dict[str, Any]) -> None:
    """Load CUDA/sherpa only after the spawned interpreter has a clean ABI."""

    streams: dict[str, Any] = {}
    try:
        _preload_cuda_libraries(
            tuple(Path(item) for item in config["cuda_roots"]),
            Path(config["libstdcpp_path"]) if config.get("libstdcpp_path") else None,
        )
        import sherpa_onnx  # type: ignore[import-not-found]

        runtime_version = str(getattr(sherpa_onnx, "__version__", "unknown"))
        if "+cuda" not in runtime_version:
            raise RuntimeError(
                f"Installed sherpa-onnx {runtime_version} is CPU-only; "
                "an official +cuda wheel is required"
            )
        paths = config["paths"]
        recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=paths["tokens"],
            encoder=paths["encoder"],
            decoder=paths["decoder"],
            joiner=paths["joiner"],
            num_threads=int(config["num_threads"]),
            sample_rate=_SAMPLE_RATE,
            feature_dim=80,
            decoding_method="greedy_search",
            provider="cuda",
            model_type="zipformer2",
            enable_endpoint_detection=False,
        )
        _warm_up_recognizer(recognizer, int(config["chunk_ms"]))
        connection.send(
            {
                "status": "ready",
                "runtime_version": runtime_version,
                "pid": os.getpid(),
            }
        )

        while True:
            request = connection.recv()
            command = request.get("command")
            try:
                if command == "shutdown":
                    connection.send({"status": "ok"})
                    return
                if command == "create_stream":
                    stream_id = uuid.uuid4().hex
                    streams[stream_id] = recognizer.create_stream()
                    connection.send({"status": "ok", "stream_id": stream_id})
                    continue

                stream_id = str(request.get("stream_id", ""))
                stream = streams.get(stream_id)
                if stream is None:
                    raise RuntimeError(f"Unknown X-ASR stream: {stream_id}")
                if command == "accept":
                    pcm_bytes = bytes(request.get("pcm", b""))
                    samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
                    stream.accept_waveform(_SAMPLE_RATE, samples)
                    _drain_ready_stream(recognizer, stream)
                    connection.send({"status": "ok", "text": recognizer.get_result(stream)})
                    continue
                if command == "finish":
                    stream.input_finished()
                    _drain_ready_stream(recognizer, stream)
                    text = recognizer.get_result(stream)
                    streams.pop(stream_id, None)
                    connection.send({"status": "ok", "text": text})
                    continue
                raise RuntimeError(f"Unsupported X-ASR worker command: {command}")
            except Exception as exc:
                connection.send({"status": "error", "error": f"{type(exc).__name__}: {exc}"})
    except EOFError:
        return
    except Exception as exc:
        with contextlib.suppress(BrokenPipeError, EOFError, OSError):
            connection.send(
                {
                    "status": "error",
                    "error": f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}",
                }
            )
    finally:
        connection.close()


class _XASRWorkerStreamingSession(BaseStreamingASRSession):
    def __init__(
        self,
        worker: _XASRWorkerClient,
        stream_id: str,
        text_format: str,
        language: str | None,
        on_runtime_failure: Callable[[], None],
    ) -> None:
        self._worker = worker
        self._stream_id = stream_id
        self._text_format = text_format
        self._language = language if language not in {None, "auto"} else None
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
        self._samples += len(pcm_bytes) // 2
        try:
            text = await asyncio.to_thread(self._worker.accept_pcm, self._stream_id, pcm_bytes)
        except Exception as exc:
            self._on_runtime_failure()
            raise classify_model_error(exc, "x-asr") from exc
        text = _format_text(text, self._text_format)
        if text == self._last_text:
            return None
        self._last_text = text
        return self._result(text, is_final=False)

    async def finish(self) -> ASRResult:
        if not self._finished:
            self._finished = True
            try:
                text = await asyncio.to_thread(self._worker.finish, self._stream_id)
            except Exception as exc:
                self._on_runtime_failure()
                raise classify_model_error(exc, "x-asr") from exc
            self._last_text = _format_text(text, self._text_format)
        return self._result(self._last_text, is_final=True)

    def _result(self, text: str, is_final: bool) -> ASRResult:
        duration = self._samples / _SAMPLE_RATE
        return ASRResult(
            full_text=text,
            segments=[Segment(start=0.0, end=duration, text=text)] if text else [],
            language=self._language,
            engine_name="x-asr",
            raw={"is_final": is_final, "duration_sec": duration, "streaming": True},
        )


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


def _sherpa_version(import_runtime: bool = True) -> str:
    if not import_runtime:
        try:
            return importlib.metadata.version("sherpa-onnx")
        except importlib.metadata.PackageNotFoundError:
            return "not-installed"
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


def _preload_cuda_libraries(
    configured_roots: tuple[Path, ...],
    libstdcpp_path: Path | None,
) -> None:
    if libstdcpp_path is not None:
        if not libstdcpp_path.is_file():
            raise RuntimeError(f"X-ASR libstdc++ does not exist: {libstdcpp_path}")
        ctypes.CDLL(str(libstdcpp_path), mode=ctypes.RTLD_GLOBAL)
    if not configured_roots:
        raise RuntimeError(
            "X-ASR CUDA runtime path is not configured. Set X_ASR_CUDA_LIBRARY_PATH "
            "to the NVIDIA runtime package root used by the sherpa CUDA wheel."
        )
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
        for root in configured_roots:
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
            + ". Set X_ASR_CUDA_LIBRARY_PATH to the matching CUDA 12 NVIDIA runtime root."
        )


def _cuda_library_directories(configured_roots: tuple[Path, ...]) -> tuple[Path, ...]:
    directories: list[Path] = []
    for root in configured_roots:
        if not root.is_dir():
            continue
        for library in root.rglob("*.so*"):
            parent = library.parent
            if parent not in directories:
                directories.append(parent)
    return tuple(directories)
