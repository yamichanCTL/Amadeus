from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.core.model_downloads import DownloadError, ModelDownloadManager, safe_relative, trusted_url


REVISION = "a" * 40


def catalog_for(content: bytes, *, sources=None, required=None, identifier="fixture", git=False):
    digest = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest() if git else hashlib.sha256(content).hexdigest()
    snapshot = {"revision": REVISION, "files": [{"path": "model.bin", "size": len(content), "git_sha1" if git else "sha256": digest}]}
    return {"version": 1, "models": [{"id": identifier, "engine": "whisper", "model_name": identifier, "label": "fixture", "directory": identifier,
            "required_files": required or ["model.bin"], "runtime_extra": "whisper", "sources": sources or [{"id": "hf-mirror", "repo": "official/model", "revision": REVISION, "snapshot": snapshot}]}]}


def manager_for(tmp_path, catalog, handler, **kwargs):
    locks: dict[str, asyncio.Lock] = {}
    return ModelDownloadManager(settings=SimpleNamespace(models_dir=tmp_path / "models"), catalog=catalog,
                                transport=httpx.MockTransport(handler), is_loaded=kwargs.pop("is_loaded", lambda _: False),
                                engine_lock=kwargs.pop("engine_lock", lambda engine: locks.setdefault(engine, asyncio.Lock())), **kwargs)


async def finish(manager, identifier="fixture", **kwargs):
    await manager.start(identifier, **kwargs)
    if identifier in manager.tasks:
        await asyncio.wait_for(manager.tasks[identifier], timeout=8)
    return manager.jobs[identifier]


@pytest.mark.parametrize("path", ["../model", "/model", "C:/model", "a\\b", "a/../b", "NUL.bin", "a/COM1", "a./b", "a ", "a:stream", "bad?file", "a//b"])
def test_reject_windows_path_traversal_and_reserved_names(path):
    with pytest.raises(DownloadError):
        safe_relative(path)


@pytest.mark.parametrize("url", ["http://huggingface.co/a", "https://127.0.0.1/model", "https://huggingface.co.evil.org/model", "https://user:pass@huggingface.co/a", "https://huggingface.co:8080/a"])
def test_reject_non_catalog_url_origins(url):
    with pytest.raises(DownloadError):
        trusted_url(url)


@pytest.mark.asyncio
async def test_verified_mirror_uses_shipped_official_snapshot_without_hf_access(tmp_path):
    content = b"real weight fixture"
    requests = []
    async def handler(request):
        requests.append(request)
        assert request.url.host == "hf-mirror.com"
        assert REVISION in request.url.path
        return httpx.Response(200, content=content)
    manager = manager_for(tmp_path, catalog_for(content), handler)
    try:
        job = await finish(manager)
        assert job["status"] == "completed"
        assert len(requests) == 1
        assert (tmp_path / "models/fixture/model.bin").read_bytes() == content
        row = manager.catalog()["models"][0]
        assert row["weights"]["verified"] is True
        assert row["runtime"]["extra"] == "whisper"
        assert not any(item["id"] == "huggingface" for item in row["sources"])
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_git_blob_integrity_and_tampered_installed_file_not_ready(tmp_path):
    content = b'{"configuration":true}'
    manager = manager_for(tmp_path, catalog_for(content, git=True), lambda _: httpx.Response(200, content=content))
    try:
        assert (await finish(manager))["status"] == "completed"
        (tmp_path / "models/fixture/model.bin").write_bytes(b"tampered")
        assert manager.catalog()["models"][0]["weights"] == {"status": "existing", "verified": False, "path": str(tmp_path / "models/fixture")}
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_corrupt_content_never_published_and_existing_user_files_preserved(tmp_path):
    expected, corrupt = b"good-weight", b"evil-weight"
    existing = tmp_path / "models/fixture"
    existing.mkdir(parents=True)
    (existing / "model.bin").write_bytes(b"original")
    manager = manager_for(tmp_path, catalog_for(expected), lambda _: httpx.Response(200, content=corrupt))
    try:
        job = await finish(manager)
        assert job["status"] == "error"
        assert "校验" in job["error"]
        assert job["downloaded_bytes"] == 0
        assert (existing / "model.bin").read_bytes() == b"original"
        assert not (existing / ".amadeus-model.json").exists()
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_cancel_restart_resumes_range_with_etag_and_no_partial_ready(tmp_path):
    content = b"A" * (768 * 1024)
    entered = asyncio.Event()
    requested_offsets = []
    class Interruptible(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield content[:256 * 1024]
            entered.set()
            await asyncio.Event().wait()
    async def handler(request):
        offset = int(request.headers.get("range", "bytes=0-")[6:-1])
        requested_offsets.append(offset)
        if offset == 0:
            return httpx.Response(200, headers={"etag": '"version-one"'}, stream=Interruptible())
        assert request.headers["if-range"] == '"version-one"'
        return httpx.Response(206, headers={"etag": '"version-one"', "content-range": f"bytes {offset}-{len(content)-1}/{len(content)}"}, content=content[offset:])
    catalog = catalog_for(content)
    manager = manager_for(tmp_path, catalog, handler)
    await manager.start("fixture")
    await asyncio.wait_for(entered.wait(), 3)
    assert manager.jobs["fixture"]["downloaded_bytes"] == 256 * 1024
    assert manager.jobs["fixture"]["current_file_downloaded_bytes"] == 256 * 1024
    assert manager.jobs["fixture"]["current_file_total_bytes"] == len(content)
    assert manager.jobs["fixture"]["files"][0]["downloaded_bytes"] == 256 * 1024
    assert manager.catalog()["models"][0]["weights"]["status"] == "missing"
    await manager.close()
    assert manager.jobs["fixture"]["status"] == "cancelled"
    restarted = manager_for(tmp_path, catalog, handler)
    try:
        assert restarted.jobs["fixture"]["status"] == "cancelled"
        assert (await finish(restarted))["status"] == "completed"
        assert restarted.jobs["fixture"]["transferred_bytes"] == len(content) - 256 * 1024
        assert restarted.jobs["fixture"]["completed_files"] == 1
        assert requested_offsets == [0, 256 * 1024]
        assert (tmp_path / "models/fixture/model.bin").read_bytes() == content
    finally:
        await restarted.close()


@pytest.mark.asyncio
async def test_verified_installed_inventory_reports_real_sizes_without_old_job_metadata(tmp_path):
    content = b"existing verified weights"
    requests = []
    manager = manager_for(tmp_path, catalog_for(content), lambda request: (requests.append(request), httpx.Response(200, content=content))[1])
    try:
        await finish(manager)
        manager.jobs.clear()
        job = await manager.start("fixture")
        assert job["status"] == "completed"
        assert job["downloaded_bytes"] == job["total_bytes"] == len(content)
        assert job["total_files"] == job["completed_files"] == 1
        assert job["files"] == [{"path": "model.bin", "size": len(content), "downloaded_bytes": len(content), "status": "completed"}]
        assert len(requests) == 1
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_resume_progress_counts_later_cached_files_without_subtracting_them_from_network_speed(tmp_path):
    first, cached = b"A" * (512 * 1024), b"Z" * (1024 * 1024)
    catalog = catalog_for(first, required=["a.bin", "z.bin"])
    catalog["models"][0]["sources"][0]["snapshot"]["files"] = [
        {"path": path, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        for path, content in [("a.bin", first), ("z.bin", cached)]
    ]
    loaded = True
    resuming = False
    entered, release = asyncio.Event(), asyncio.Event()
    class BlockedFirst(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield first[:256 * 1024]
            entered.set()
            await release.wait()
            yield first[256 * 1024:]
    def handler(request):
        if request.url.path.endswith("a.bin"):
            return httpx.Response(200, stream=BlockedFirst()) if resuming else httpx.Response(200, content=first)
        return httpx.Response(200, content=cached)
    manager = manager_for(tmp_path, catalog, handler, is_loaded=lambda _: loaded)
    try:
        assert (await finish(manager))["status"] == "error"  # retain staged data while loaded
        staged_first = next(manager._stage(catalog["models"][0]).glob("*/payload/a.bin"))
        staged_first.write_bytes(b"damaged fixture")
        loaded, resuming = False, True
        await manager.start("fixture")
        await asyncio.wait_for(entered.wait(), 3)
        job = manager.jobs["fixture"]
        assert job["downloaded_bytes"] == len(cached) + 256 * 1024
        assert job["transferred_bytes"] == 256 * 1024
        assert job["speed_bytes_per_second"] > 0
        assert job["completed_files"] == 0
        assert job["files"][1]["downloaded_bytes"] == len(cached)
        release.set()
        await manager.tasks["fixture"]
        assert job["status"] == "completed"
        assert job["downloaded_bytes"] == job["total_bytes"] == len(first) + len(cached)
        assert job["transferred_bytes"] == len(first)
        assert job["completed_files"] == 2
        assert all(item["status"] == "completed" for item in job["files"])
        assert all("url" not in item and "digest" not in item for item in job["files"])
    finally:
        release.set()
        await manager.close()


@pytest.mark.asyncio
async def test_source_switch_clears_previous_inventory_until_new_source_is_known(tmp_path):
    content = b"official weight"
    catalog = catalog_for(content)
    catalog["models"][0]["sources"].append({"id": "huggingface", "repo": "official/model", "revision": "main"})
    entered, release = asyncio.Event(), asyncio.Event()
    async def handler(request):
        if request.url.host == "hf-mirror.com":
            return httpx.Response(200, content=b"corrupt-content")
        if "/api/models/" in request.url.path:
            entered.set()
            await release.wait()
            return httpx.Response(200, json={"sha": REVISION, "siblings": [{"rfilename": "model.bin", "lfs": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}}]})
        return httpx.Response(200, content=content)
    manager = manager_for(tmp_path, catalog, handler)
    try:
        await manager.start("fixture")
        await asyncio.wait_for(entered.wait(), 4)
        job = manager.jobs["fixture"]
        assert job["source"] == "huggingface"
        assert job["status"] == "queued"
        assert job["total_bytes"] == job["downloaded_bytes"] == 0
        assert job["files"] == []
        release.set()
        await manager.tasks["fixture"]
        assert job["status"] == "completed"
    finally:
        release.set()
        await manager.close()


@pytest.mark.asyncio
async def test_server_ignores_range_replaces_instead_of_appending(tmp_path):
    content = b"ABCDE" * 10
    catalog = catalog_for(content)
    manager = manager_for(tmp_path, catalog, lambda _: httpx.Response(200, content=content))
    item = {"path": "model.bin", "size": len(content), "algorithm": "sha256", "digest": hashlib.sha256(content).hexdigest(), "url": "https://hf-mirror.com/official/model/file"}
    payload, partials = tmp_path / "payload", tmp_path / "partials"
    partials.mkdir()
    partial = partials / (hashlib.sha256(b"model.bin").hexdigest()[:20] + ".part")
    partial.write_bytes(content[:10])
    job = {"id": "fixture", "downloaded_bytes": 0}
    try:
        async with httpx.AsyncClient(transport=manager.transport) as client:
            await manager._file(client, item, payload / "model.bin", partials, job, 0, 0)
        assert (payload / "model.bin").read_bytes() == content
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_auto_fallback_and_invalid_inventory_never_downloads_arbitrary_paths(tmp_path):
    content = b"fallback-weight"
    catalog = catalog_for(content)
    catalog["models"][0]["sources"].insert(0, {"id": "modelscope", "repo": "official/model", "revision": "master"})
    hosts = []
    async def handler(request):
        hosts.append(request.url.host)
        if request.url.host == "modelscope.cn":
            return httpx.Response(503)
        return httpx.Response(200, content=content)
    manager = manager_for(tmp_path, catalog, handler)
    try:
        job = await finish(manager)
        assert job["status"] == "completed"
        assert job["source"] == "hf-mirror"
        assert hosts == ["modelscope.cn", "hf-mirror.com"]
        assert job["attempts"][0]["source"] == "modelscope"
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_missing_required_inventory_cannot_be_promoted(tmp_path):
    content = b"tiny config"
    manager = manager_for(tmp_path, catalog_for(content, required=["model.bin", "config.json"]), lambda _: pytest.fail("No file request should be made"))
    try:
        assert (await finish(manager))["status"] == "error"
        assert not (tmp_path / "models/fixture").exists()
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_selected_modelscope_inventory_uses_each_pinned_revision(tmp_path):
    content = b"official model"
    revision = "b" * 40
    source = {"id": "modelscope", "repo": "official/model", "revision": "master"}
    urls = []
    async def handler(request):
        urls.append(str(request.url))
        if "/api/" in request.url.path:
            return httpx.Response(200, json={"Code": 200, "Success": True, "Data": {"Files": [{"Type": "blob", "Path": "model.bin", "Revision": revision, "Size": len(content), "Sha256": hashlib.sha256(content).hexdigest()}]}})
        assert f"/resolve/{revision}/" in request.url.path
        return httpx.Response(200, content=content)
    manager = manager_for(tmp_path, catalog_for(content, sources=[source]), handler)
    try:
        assert (await finish(manager))["status"] == "completed"
        assert len(urls) == 2
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_model_load_lock_prevents_promotion_and_retry_reuses_complete_staging(tmp_path):
    content = b"new-model"
    loaded = True
    manager = manager_for(tmp_path, catalog_for(content), lambda _: httpx.Response(200, content=content), is_loaded=lambda _: loaded)
    existing = tmp_path / "models/fixture"
    existing.mkdir(parents=True)
    (existing / "original-user.txt").write_text("keep", encoding="utf-8")
    try:
        assert (await finish(manager))["status"] == "error"
        assert (existing / "original-user.txt").exists()
        assert not (existing / "model.bin").exists()
        loaded = False
        job = await finish(manager)
        assert job["status"] == "completed"
        assert (Path(job["backup_path"]) / "original-user.txt").read_text() == "keep"
        assert (existing / "model.bin").read_bytes() == content
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_duplicate_start_uses_one_task_and_global_limit_two(tmp_path):
    content = b"A" * (512 * 1024)
    catalog = catalog_for(content)
    catalog["models"] += [catalog_for(content, identifier=name)["models"][0] for name in ("second", "third")]
    active = 0
    maximum = 0
    started = asyncio.Event()
    class Blocked(httpx.AsyncByteStream):
        async def __aiter__(self):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            if active == 2:
                started.set()
            try:
                yield content[:256 * 1024]
                await asyncio.Event().wait()
            finally:
                active -= 1
    manager = manager_for(tmp_path, catalog, lambda _: httpx.Response(200, stream=Blocked()))
    try:
        await manager.start("fixture")
        first = manager.tasks["fixture"]
        await manager.start("fixture")
        assert manager.tasks["fixture"] is first
        await manager.start("second")
        await manager.start("third")
        await asyncio.wait_for(started.wait(), 3)
        assert maximum == 2
        assert manager.jobs["third"]["status"] == "queued"
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_cancel_and_immediate_restart_never_mark_replacement_task_cancelled(tmp_path):
    content = b"finished"
    manager = manager_for(tmp_path, catalog_for(content), lambda _: httpx.Response(200, content=content))
    cancellation_entered = asyncio.Event()
    release_old_task = asyncio.Event()
    async def old_worker():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancellation_entered.set()
            await release_old_task.wait()
    previous = asyncio.create_task(old_worker())
    await asyncio.sleep(0)
    manager.tasks["fixture"] = previous
    manager.jobs["fixture"] = {"id": "fixture", "status": "downloading"}
    cancel = asyncio.create_task(manager.cancel("fixture"))
    await cancellation_entered.wait()
    restart = asyncio.create_task(manager.start("fixture"))
    await asyncio.sleep(0)
    assert not restart.done()
    release_old_task.set()
    assert (await cancel)["status"] == "cancelled"
    assert (await restart)["status"] == "queued"
    await manager.tasks["fixture"]
    assert manager.jobs["fixture"]["status"] == "completed"
    await manager.close()


@pytest.mark.asyncio
async def test_promotion_waits_for_engine_loading_lock_then_rechecks_loaded(tmp_path):
    content = b"weight"
    lock = asyncio.Lock()
    await lock.acquire()
    loaded = False
    manager = manager_for(tmp_path, catalog_for(content), lambda _: httpx.Response(200, content=content),
                          is_loaded=lambda _: loaded, engine_lock=lambda _: lock)
    try:
        await manager.start("fixture")
        for _ in range(100):
            if manager.jobs["fixture"]["status"] == "verifying":
                break
            await asyncio.sleep(.01)
        assert not manager.tasks["fixture"].done()
        assert not (tmp_path / "models/fixture").exists()
        loaded = True
        lock.release()
        await manager.tasks["fixture"]
        assert manager.jobs["fixture"]["status"] == "error"
        assert "正在使用" in manager.jobs["fixture"]["error"]
        assert not (tmp_path / "models/fixture").exists()
    finally:
        if lock.locked():
            lock.release()
        await manager.close()


@pytest.mark.asyncio
async def test_api_rejects_unlisted_url_or_model(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from app.api.v1 import model_downloads
    manager = manager_for(tmp_path, catalog_for(b"weight"), lambda _: httpx.Response(200, content=b"weight"))
    monkeypatch.setattr(model_downloads, "get_model_download_manager", lambda: manager)
    app = FastAPI()
    app.include_router(model_downloads.router, prefix="/v1")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.post("/v1/model-downloads/fixture/start", json={"url": "https://evil.org/weights"})).status_code == 422
            assert (await client.post("/v1/model-downloads/unknown/start", json={})).status_code == 404
            assert (await client.post("/v1/model-downloads/fixture/start", json={"source": "github"})).status_code == 400
            assert (await client.get("/v1/model-downloads/catalog")).status_code == 200
    finally:
        await manager.close()
