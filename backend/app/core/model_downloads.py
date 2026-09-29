"""Verified, resumable model downloads; only the shipped catalog can choose URLs/paths.

Weights stay in a same-volume staging directory until every selected remote file has
passed its authoritative hash. Runtime dependencies and loaded engines are separate.
"""
from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import time
from typing import Any, Callable
from urllib.parse import quote, urlencode, urlsplit

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)
ACTIVE = {"queued", "downloading", "verifying"}
MARKER = ".amadeus-model.json"
SOURCE_IDS = {"huggingface", "modelscope", "hf-mirror", "github"}
SETTING_FIELDS = {"sensevoice_model_dir", "fireredasr2_model_dir", "qwen3asr_model_dir", "formalasr_model_dir", "x_asr_model_dir"}
RUNTIME_MODULES = {
    "whisper": ["faster_whisper"], "sensevoice": ["funasr", "torch", "torchaudio", "kaldi_native_fbank"],
    "firered": ["torch", "torchaudio", "transformers", "kaldi_native_fbank", "kaldiio", "cn2an", "peft"],
    "qwen3asr": ["qwen_asr", "torch", "transformers", "accelerate"],
    "formalasr": ["qwen_asr", "torch", "transformers", "accelerate"],
    "sherpa": ["sherpa_onnx"], "x-asr": ["sherpa_onnx"], "vosk": ["vosk"],
}


class DownloadError(RuntimeError):
    pass


class LocalInstallationError(DownloadError):
    """Switching network sources cannot resolve this local installation condition."""


def safe_relative(value: str) -> str:
    """Portable Windows path validation also runs on Linux CI."""
    if not isinstance(value, str) or not value or any(char in value for char in '\\:*?"<>|\x00'):
        raise DownloadError("模型文件包含不安全路径。")
    parts = value.split("/")
    if any(part in {"", ".", ".."} or part.endswith((".", " ")) or any(ord(c) < 32 for c in part)
           or re.match(r"^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", part, re.I) for part in parts):
        raise DownloadError("模型文件包含不安全路径。")
    return PurePosixPath(value).as_posix()


def below(root: Path, relative: str) -> Path:
    value = root.joinpath(*safe_relative(relative).split("/"))
    resolved = value.resolve()
    if not resolved.is_relative_to(root.resolve()) or resolved == root.resolve():
        raise DownloadError("模型文件路径越出了安装目录。")
    return value


def trusted_url(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    domains = ("huggingface.co", "hf.co", "hf-mirror.com", "modelscope.cn", "modelscope.ai", "aliyuncs.com", "github.com", "githubusercontent.com", "githubassets.com")
    if parts.scheme != "https" or parts.username or parts.password or parts.port not in {None, 443} or not any(host == domain or host.endswith("." + domain) for domain in domains):
        raise DownloadError("下载地址不属于允许的模型平台。")
    return url


def atomic_json(file: Path, data: Any) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, file)


def digest_file(path: Path, algorithm: str, size: int) -> str:
    digest = hashlib.sha256() if algorithm == "sha256" else hashlib.sha1()
    if algorithm == "git_sha1":
        digest.update(f"blob {size}\0".encode())
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_error(exc: BaseException) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"模型平台返回 HTTP {exc.response.status_code}。"
    if isinstance(exc, httpx.RequestError):
        return f"模型平台网络连接失败（{type(exc).__name__}），可重试或换下载源。"
    return re.sub(r"https?://[^\s]+", "[模型下载地址]", str(exc))[:600]


class ModelDownloadManager:
    def __init__(self, *, settings: Any | None = None, catalog: dict[str, Any] | None = None,
                 transport: httpx.AsyncBaseTransport | None = None,
                 is_loaded: Callable[[str], bool] | None = None,
                 engine_lock: Callable[[str], asyncio.Lock] | None = None) -> None:
        self.settings = settings or get_settings()
        data = catalog or json.loads(Path(__file__).with_name("model_catalog.json").read_text(encoding="utf-8"))
        self.catalog_version = data.get("version", 1)
        self.models = {entry["id"]: entry for entry in data["models"]}
        for identifier, model in self.models.items():
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}", identifier):
                raise DownloadError("模型目录 ID 无效。")
            safe_relative(model["directory"])
            for file in model.get("required_files", []):
                safe_relative(file)
        self.control = Path(self.settings.models_dir).resolve() / ".amadeus-downloads"
        self.control.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.semaphore = asyncio.Semaphore(2)
        self.lock = asyncio.Lock()
        self.transport = transport
        self.is_loaded = is_loaded or self._engine_is_loaded
        self.engine_lock = engine_lock or self._engine_lock
        self.closed = False
        self._last_save: dict[str, float] = {}
        for identifier in self.models:
            try:
                saved = json.loads((self.control / f"{identifier}.json").read_text(encoding="utf-8"))
                if saved.get("id") != identifier:
                    continue
                if saved.get("status") in ACTIVE:
                    saved.update(status="cancelled", speed_bytes_per_second=0, message="上次下载随应用退出而暂停；再次下载将校验并续传。")
                self.jobs[identifier] = saved
            except (OSError, ValueError):
                pass

    @staticmethod
    def _engine_is_loaded(engine: str) -> bool:
        from app.core.model_manager import get_model_manager
        return get_model_manager().is_loaded(engine)

    @staticmethod
    def _engine_lock(engine: str) -> asyncio.Lock:
        from app.core.model_manager import get_model_manager
        return get_model_manager()._locks.setdefault(engine, asyncio.Lock())

    def target(self, model: dict[str, Any]) -> Path:
        engine, name = model["engine"], model["model_name"]
        helper = {"whisper": "whisper_model_path", "fireredasr2": "fireredasr2_model_path", "sensevoice": "sensevoice_model_path", "qwen3asr": "qwen3asr_model_path", "formalasr": "formalasr_model_path"}.get(engine)
        if helper and hasattr(self.settings, helper):
            target = getattr(self.settings, helper)(*([] if engine == "sensevoice" else [name]))
        elif engine == "x-asr" and hasattr(self.settings, "x_asr_model_dir"):
            safe_relative(name)
            target = Path(self.settings.x_asr_model_dir).parent / name
        else:
            field = model.get("settings_field", model.get("settings_path"))
            target = getattr(self.settings, field) if field in SETTING_FIELDS and hasattr(self.settings, field) else below(Path(self.settings.models_dir), model["directory"])
        return Path(target).resolve()

    def _stage(self, model: dict[str, Any]) -> Path:
        target = self.target(model)
        return target.parent / ".amadeus-staging" / model["id"]

    def _weights(self, model: dict[str, Any]) -> dict[str, Any]:
        target = self.target(model)
        state: dict[str, Any] = {"status": "missing", "verified": False, "path": str(target)}
        try:
            manifest = json.loads((target / MARKER).read_text(encoding="utf-8"))
            files = manifest["files"]
            if manifest.get("id") == model["id"] and files and self._required(model, {item["path"] for item in files}):
                if all((stat := below(target, item["path"]).stat()).st_size == item["size"] and stat.st_mtime_ns == item["mtime_ns"] for item in files):
                    return {**state, "status": "ready", "verified": True, "revision": manifest.get("revision"), "source": manifest.get("source")}
        except (OSError, ValueError, KeyError, TypeError, DownloadError):
            pass
        required = model.get("required_files", [])
        alternatives = model.get("required_any", [])
        if (required or alternatives) and all(below(target, name).is_file() for name in required) and all(any(below(target, name).is_file() for name in group) for group in alternatives):
            state["status"] = "existing"
        return state

    def _runtime(self, model: dict[str, Any]) -> dict[str, Any]:
        extra = model["runtime_extra"]
        missing: list[str] = []
        for module in RUNTIME_MODULES.get(extra, []):
            try:
                if importlib.util.find_spec(module) is None:
                    missing.append(module)
            except (ValueError, ImportError, ModuleNotFoundError):
                missing.append(module)
        if model["engine"] == "sensevoice":
            source = getattr(self.settings, "sensevoice_src_path", None)
            if not source or not (Path(source) / "model.py").is_file():
                missing.append("SenseVoice 源码（model.py）")
        if model["engine"] == "fireredasr2":
            source = getattr(self.settings, "fireredasr2_src_path", None) or Path(__file__).parent / "asr" / "engines" / "FireRedASR2S"
            if not (Path(source) / "fireredasr2s").is_dir():
                missing.append("FireRedASR2 源码")
        return {"installed": not missing, "extra": extra, "missing_modules": missing}

    def catalog(self) -> dict[str, Any]:
        rows = []
        for identifier, model in self.models.items():
            # Remote URL/hash inventories are implementation detail; preserve public labels.
            metadata = {key: value for key, value in model.items() if key != "sources"}
            metadata["sources"] = [{key: source[key] for key in ("id", "label", "official") if key in source} for source in model["sources"]]
            rows.append({**metadata, "weights": self._weights(model), "runtime": self._runtime(model), "job": self.jobs.get(identifier)})
        return {"models": rows, "jobs": list(self.jobs.values())}

    @staticmethod
    def _required(model: dict[str, Any], names: set[str]) -> bool:
        return all(file in names for file in model.get("required_files", [])) and all(any(file in names for file in group) for group in model.get("required_any", []))

    async def _save(self, job: dict[str, Any], force: bool = False) -> None:
        now = time.monotonic()
        if force or now - self._last_save.get(job["id"], 0) >= 1:
            self._last_save[job["id"]] = now
            job["updated_at"] = time.time()
            # Tiny atomic metadata writes avoid detached writers racing cancellation/retry.
            atomic_json(self.control / f"{job['id']}.json", job)

    async def start(self, identifier: str, *, region: str = "mainland", source: str = "auto") -> dict[str, Any]:
        if identifier not in self.models:
            raise KeyError(identifier)
        if region not in {"mainland", "global"} or source not in SOURCE_IDS | {"auto"}:
            raise DownloadError("无效的地区或下载源。")
        if source != "auto" and source not in {item["id"] for item in self.models[identifier]["sources"]}:
            raise DownloadError("这个模型不支持所选下载源。")
        async with self.lock:
            if self.closed:
                raise DownloadError("后端正在退出，请重新启动后再下载。")
            if identifier in self.tasks and not self.tasks[identifier].done():
                return dict(self.jobs[identifier])
            previous = self.jobs.get(identifier, {})
            job = {"id": identifier, "status": "queued", "region": region, "requested_source": source, "source": None,
                   "downloaded_bytes": 0, "total_bytes": 0, "speed_bytes_per_second": 0,
                   "current_file": "", "message": "等待下载，支持断点续传。", "error": None,
                   "attempts": [], "started_at": time.time()}
            if self._weights(self.models[identifier])["verified"]:
                job.update(status="completed", message="模型权重已完整校验，无需重复下载。", downloaded_bytes=previous.get("total_bytes", 0), total_bytes=previous.get("total_bytes", 0))
                self.jobs[identifier] = job
                await self._save(job, True)
                return dict(job)
            self.jobs[identifier] = job
            await self._save(job, True)
            self.tasks[identifier] = asyncio.create_task(self._run(identifier), name=f"model-download-{identifier}")
            return dict(job)

    async def cancel(self, identifier: str) -> dict[str, Any]:
        if identifier not in self.models:
            raise KeyError(identifier)
        async with self.lock:
            task = self.tasks.get(identifier)
            if task and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            job = self.jobs.get(identifier)
            if job is None:
                return {"id": identifier, "status": "cancelled", "downloaded_bytes": 0, "total_bytes": 0, "speed_bytes_per_second": 0, "current_file": ""}
            if job["status"] in ACTIVE:
                job.update(status="cancelled", speed_bytes_per_second=0, message="下载已暂停，已下载的数据会保留。")
                await self._save(job, True)
            return dict(job)

    async def close(self) -> None:
        self.closed = True
        for identifier in list(self.tasks):
            await self.cancel(identifier)

    def _sources(self, model: dict[str, Any], job: dict[str, Any]) -> list[dict[str, Any]]:
        sources = model["sources"]
        if job["requested_source"] != "auto":
            return [item for item in sources if item["id"] == job["requested_source"]]
        def score(source: dict[str, Any]) -> int:
            if job["region"] == "global":
                return {"huggingface": 0, "github": 1, "modelscope": 2, "hf-mirror": 3}[source["id"]]
            if source["id"] == "modelscope":
                return 2 if "modelscope.ai" in source.get("api_base", "") else 0
            return {"hf-mirror": 1, "huggingface": 3, "github": 4}[source["id"]]
        return sorted(sources, key=score)

    async def _run(self, identifier: str) -> None:
        job, model = self.jobs[identifier], self.models[identifier]
        try:
            async with self.semaphore:
                async with httpx.AsyncClient(transport=self.transport, timeout=httpx.Timeout(45, connect=15), follow_redirects=False, headers={"User-Agent": "Amadeus-ModelInstaller/1.0", "Accept-Encoding": "identity"}) as client:
                    for source in self._sources(model, job):
                        job.update(status="queued", source=source["id"], current_file="", error=None, speed_bytes_per_second=0, message=f"正在读取 {source['id']} 的权威文件清单……")
                        await self._save(job, True)
                        try:
                            files, revision = await self._inventory(client, model, source)
                            await self._download_inventory(client, model, job, files, revision)
                            return
                        except LocalInstallationError:
                            raise
                        except (DownloadError, httpx.HTTPError, OSError, ValueError, KeyError) as exc:
                            reason = safe_error(exc)
                            job["attempts"].append({"source": source["id"], "error": reason})
                            job.update(error=reason, message="此下载源不可用，正在尝试下一个允许的来源。", speed_bytes_per_second=0)
                            await self._save(job, True)
                    raise DownloadError("可用下载源均未完成：" + "；".join(f"{item['source']}: {item['error']}" for item in job["attempts"]))
        except asyncio.CancelledError:
            job.update(status="cancelled", speed_bytes_per_second=0, message="下载已暂停，已下载的数据会保留；再次下载可续传。")
            await self._save(job, True)
        except Exception as exc:
            job.update(status="error", error=safe_error(exc), message="下载未完成，请重试或切换来源。", speed_bytes_per_second=0)
            await self._save(job, True)

    async def _response(self, client: httpx.AsyncClient, url: str, *, headers: dict[str, str] | None = None) -> httpx.Response:
        for _ in range(8):
            request = client.build_request("GET", trusted_url(url), headers=headers)
            response = await client.send(request, stream=True)
            if response.status_code in {301, 302, 303, 307, 308}:
                next_url = str(response.url.join(response.headers.get("location", "")))
                await response.aclose()
                url = trusted_url(next_url)
                continue
            return response
        raise DownloadError("模型平台重定向次数过多。")

    async def _json(self, client: httpx.AsyncClient, url: str) -> Any:
        response = await self._response(client, url)
        try:
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 32 * 1024 * 1024:
                    raise DownloadError("远端模型清单超过允许大小。")
            return json.loads(data)
        finally:
            await response.aclose()

    async def _inventory(self, client: httpx.AsyncClient, model: dict[str, Any], source: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
        kind, revision = source["id"], source.get("revision", "main")
        repo = source.get("repo", "")
        if kind != "github" and not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise DownloadError("模型仓库名称无效。")
        raw: list[dict[str, Any]] = []
        if kind in {"huggingface", "hf-mirror"}:
            snapshot = source.get("snapshot") if kind == "hf-mirror" else None
            if snapshot:
                revision = snapshot["revision"]
                raw = snapshot["files"]
            else:
                data = await self._json(client, f"https://huggingface.co/api/models/{repo}/revision/{quote(revision, safe='')}?blobs=true")
                revision = data["sha"]
                for item in data["siblings"]:
                    lfs = item.get("lfs") or {}
                    raw.append({"path": item["rfilename"], "size": item.get("size", lfs.get("size")), "sha256": lfs.get("sha256"), "git_sha1": None if lfs else item.get("blobId")})
            if not re.fullmatch(r"[0-9a-f]{40}", revision):
                raise DownloadError("Hugging Face 未提供固定版本，拒绝未经验证的下载。")
            host = "hf-mirror.com" if kind == "hf-mirror" else "huggingface.co"
            raw = [{**item, "url": f"https://{host}/{repo}/resolve/{revision}/{quote(item['path'], safe='/')}"} for item in raw]
        elif kind == "modelscope":
            base = source.get("api_base", "https://modelscope.cn").rstrip("/")
            download_base = source.get("download_base", base).rstrip("/")
            if urlsplit(base).hostname not in {"modelscope.cn", "www.modelscope.cn", "modelscope.ai", "www.modelscope.ai"} or urlsplit(download_base).hostname not in {"modelscope.cn", "www.modelscope.cn", "modelscope.ai", "www.modelscope.ai"}:
                raise DownloadError("ModelScope 清单必须来自官方域名。")
            data = await self._json(client, f"{base}/api/v1/models/{repo}/repo/files?{urlencode({'Revision': revision, 'Recursive': 'true'})}")
            if data.get("Code") != 200 or not data.get("Success", True):
                raise DownloadError("ModelScope 没有返回有效的官方文件清单。")
            for item in data["Data"]["Files"]:
                if item.get("Type") != "blob":
                    continue
                file_revision = item.get("Revision", "")
                if not re.fullmatch(r"[0-9a-f]{40}", file_revision):
                    raise DownloadError("ModelScope 文件缺少固定提交版本。")
                raw.append({"path": item["Path"], "size": item["Size"], "sha256": item.get("Sha256"), "revision": file_revision,
                            "url": f"{download_base}/models/{repo}/resolve/{file_revision}/{quote(item['Path'], safe='/')}"})
            revision = "inventory-" + hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()
        elif kind == "github":
            raw = source.get("files", [])
        else:
            raise DownloadError("未知模型来源。")
        includes, excludes = source.get("include", ["*"]), source.get("exclude", [])
        prefix = source.get("strip_prefix", "")
        if prefix:
            safe_relative(prefix.rstrip("/"))
        files, names = [], set()
        for item in raw:
            remote = safe_relative(item["path"])
            if not any(fnmatch.fnmatchcase(remote, pattern) for pattern in includes) or any(fnmatch.fnmatchcase(remote, pattern) for pattern in excludes):
                continue
            if prefix and not remote.startswith(prefix):
                raise DownloadError("模型文件不在指定子目录中。")
            name = safe_relative(remote[len(prefix):] if prefix else remote)
            if name.casefold() in names or name.casefold() == MARKER.casefold():
                raise DownloadError("远端模型清单包含重复或保留文件名。")
            names.add(name.casefold())
            algorithm = "sha256" if item.get("sha256") else "git_sha1"
            digest = item.get(algorithm, "")
            if not re.fullmatch(r"[0-9a-f]{64}" if algorithm == "sha256" else r"[0-9a-f]{40}", digest or ""):
                raise DownloadError(f"官方清单未提供 {name} 的完整校验值。")
            size = item.get("size")
            if not isinstance(size, int) or size < 0:
                raise DownloadError(f"官方清单未提供 {name} 的有效大小。")
            files.append({"path": name, "size": size, "algorithm": algorithm, "digest": digest, "url": trusted_url(item["url"])})
        if not files or len(files) > 20_000 or not self._required(model, {item["path"] for item in files}):
            raise DownloadError("远端模型文件不完整，缺少引擎需要的权重或配置。")
        return sorted(files, key=lambda item: item["path"]), revision

    async def _download_inventory(self, client: httpx.AsyncClient, model: dict[str, Any], job: dict[str, Any], files: list[dict[str, Any]], revision: str) -> None:
        fingerprint = hashlib.sha256(json.dumps([{key: item[key] for key in ("path", "size", "algorithm", "digest")} for item in files], sort_keys=True).encode()).hexdigest()
        # Keep Windows paths short even under a Chinese/space-containing user profile.
        # Integrity still uses the complete SHA256; these are only directory labels.
        staging = self._stage(model) / fingerprint[:20]
        payload, partials = staging / "payload", staging / "partials"
        payload.mkdir(parents=True, exist_ok=True)
        partials.mkdir(parents=True, exist_ok=True)
        total = sum(item["size"] for item in files)
        existing = 0
        for item in files:
            destination = below(payload, item["path"])
            partial = partials / (hashlib.sha256(item["path"].encode()).hexdigest()[:20] + ".part")
            local = destination if destination.is_file() else partial
            if local.is_file():
                existing += min(local.stat().st_size, item["size"])
        if shutil.disk_usage(staging).free < max(0, total - existing) + 64 * 1024 * 1024:
            raise LocalInstallationError("模型所在磁盘空间不足，请释放空间后重试。")
        job.update(status="downloading", revision=revision, total_bytes=total, downloaded_bytes=0, message="正在下载模型文件；离开页面不会中断。")
        await self._save(job, True)
        completed = 0
        started, baseline = time.monotonic(), existing
        for item in files:
            destination = below(payload, item["path"])
            job["current_file"] = item["path"]
            if destination.is_file() and destination.stat().st_size == item["size"] and await asyncio.to_thread(digest_file, destination, item["algorithm"], item["size"]) == item["digest"]:
                completed += item["size"]
                job["downloaded_bytes"] = completed
                continue
            await self._file(client, item, destination, partials, job, completed, started, baseline)
            completed += item["size"]
        job.update(status="verifying", downloaded_bytes=total, speed_bytes_per_second=0, message="正在验证全部模型文件……")
        await self._save(job, True)
        records = []
        for item in files:
            destination = below(payload, item["path"])
            stat = destination.stat()
            if stat.st_size != item["size"] or await asyncio.to_thread(digest_file, destination, item["algorithm"], item["size"]) != item["digest"]:
                raise DownloadError(f"{item['path']} 完整性校验失败，没有安装不完整模型。")
            records.append({key: item[key] for key in ("path", "size", "algorithm", "digest")} | {"mtime_ns": stat.st_mtime_ns})
        target = self.target(model)
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(payload / MARKER, {"id": model["id"], "source": job["source"], "revision": revision, "verified_at": time.time(), "files": records})
        async with self.engine_lock(model["engine"]):
            if self.is_loaded(model["engine"]):
                raise LocalInstallationError("这个引擎正在使用。请先卸载模型，再点击下载继续完成安装；已下载文件会保留。")
            # Share the engine load/unload lock. No await between renames: cancellation
            # or a concurrent model load cannot observe a partially moved model.
            backup = target.with_name(target.name + f".amadeus-backup-{time.time_ns()}") if target.exists() else None
            if backup:
                os.replace(target, backup)
            try:
                os.replace(payload, target)
            except OSError:
                if backup and not target.exists():
                    os.replace(backup, target)
                raise
        job.update(status="completed", current_file="", message="模型权重已下载并校验。运行依赖需要单独安装。", error=None, backup_path=str(backup) if backup else None)
        await self._save(job, True)

    async def _file(self, client: httpx.AsyncClient, item: dict[str, Any], destination: Path, partials: Path, job: dict[str, Any], completed: int, started: float, baseline: int) -> None:
        stem = hashlib.sha256(item["path"].encode()).hexdigest()[:20]
        partial, resume_meta = partials / (stem + ".part"), partials / (stem + ".json")
        destination.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(3):
            offset = partial.stat().st_size if partial.is_file() else 0
            if offset > item["size"]:
                partial.unlink()
                offset = 0
            etag = None
            try:
                etag = json.loads(resume_meta.read_text(encoding="utf-8")).get("etag")
            except (OSError, ValueError):
                pass
            try:
                if offset != item["size"] or not partial.exists():
                    headers: dict[str, str] = {}
                    if offset:
                        headers["Range"] = f"bytes={offset}-"
                        if etag and not etag.startswith("W/"):
                            headers["If-Range"] = etag
                    response = await self._response(client, item["url"], headers=headers)
                    try:
                        response.raise_for_status()
                        if response.status_code == 206:
                            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", ""))
                            if not match or int(match[1]) != offset or int(match[3]) != item["size"] or int(match[2]) != item["size"] - 1:
                                raise DownloadError("断点续传的远端文件大小或偏移不一致。")
                            if etag and response.headers.get("etag") and response.headers["etag"] != etag:
                                partial.unlink(missing_ok=True)
                                raise DownloadError("下载源文件版本变化，正在重新下载并校验。")
                        elif response.status_code == 200:
                            offset = 0  # Server ignored Range: replace instead of appending twice.
                        else:
                            raise DownloadError("下载源没有返回完整文件或有效续传数据。")
                        atomic_json(resume_meta, {"etag": response.headers.get("etag"), "digest": item["digest"]})
                        with partial.open("ab" if offset else "wb") as output:
                            async for chunk in response.aiter_bytes(256 * 1024):
                                offset += len(chunk)
                                if offset > item["size"]:
                                    raise DownloadError("下载内容超过官方清单大小，已拒绝。")
                                output.write(chunk)
                                job["downloaded_bytes"] = completed + offset
                                job["speed_bytes_per_second"] = max(0, int((completed + offset - baseline) / max(.1, time.monotonic() - started)))
                                await self._save(job)
                            output.flush()
                            os.fsync(output.fileno())
                    finally:
                        await response.aclose()
                if not partial.exists() or partial.stat().st_size != item["size"]:
                    raise DownloadError("下载文件长度不足；可继续断点续传。")
                if await asyncio.to_thread(digest_file, partial, item["algorithm"], item["size"]) != item["digest"]:
                    partial.unlink()
                    raise DownloadError("下载文件校验值与官方清单不符，已丢弃损坏文件。")
                os.replace(partial, destination)
                resume_meta.unlink(missing_ok=True)
                return
            except (httpx.HTTPError, OSError, DownloadError):
                if attempt == 2:
                    raise
                await asyncio.sleep(.4 * (attempt + 1))


_manager: ModelDownloadManager | None = None


def get_model_download_manager() -> ModelDownloadManager:
    global _manager
    if _manager is None:
        _manager = ModelDownloadManager()
    return _manager


async def close_model_download_manager() -> None:
    global _manager
    if _manager is not None:
        await _manager.close()
        _manager = None
