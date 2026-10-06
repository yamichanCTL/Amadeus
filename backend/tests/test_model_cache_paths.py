"""Cache contracts without remote requests or model loading."""
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.core.model_cache import huggingface_cache_dir


def test_cache_uses_managed_environment_or_project_fallback_without_creating_files(monkeypatch, tmp_path):
    for name in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_HOME"):
        monkeypatch.delenv(name, raising=False)
    settings = SimpleNamespace(project_root=tmp_path)
    assert huggingface_cache_dir(settings) == tmp_path / "cache/huggingface/hub"
    monkeypatch.setenv("HF_HOME", str(tmp_path / "managed-cache/huggingface"))
    assert huggingface_cache_dir(settings) == tmp_path / "managed-cache/huggingface/hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "explicit-hub"))
    assert huggingface_cache_dir(settings) == tmp_path / "explicit-hub"
    assert not (tmp_path / "explicit-hub").exists()


@pytest.mark.asyncio
async def test_remote_qwen_fallback_passes_managed_cache_to_library(monkeypatch, tmp_path):
    from app.core.asr.engines import qwen3asr
    cache = tmp_path / "managed-cache/huggingface/hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache))
    factory = MagicMock(return_value=object())
    monkeypatch.setitem(sys.modules, "qwen_asr", SimpleNamespace(Qwen3ASRModel=SimpleNamespace(from_pretrained=factory)))
    monkeypatch.setattr(qwen3asr, "_resolve_torch_dtype", lambda name: name)
    engine = qwen3asr.Qwen3ASREngine(model_name="test/model", model_dir=str(tmp_path / "missing-weights"), device="cpu", torch_dtype="float32")
    await engine.load()
    factory.assert_called_once_with("test/model", cache_dir=str(cache), device_map="cpu", dtype="float32")


def test_tts_downloader_uses_the_same_configured_directory_as_the_adapter(monkeypatch, tmp_path):
    import importlib
    from app import config
    from app.core.tts import download_models
    original = download_models.TTS_DIR, download_models.PRETRAINED_DIR
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(tts_data_dir=tmp_path / "managed/tts"))
    try:
        importlib.reload(download_models)
        assert download_models.PRETRAINED_DIR == tmp_path / "managed/tts/pretrained_models"
        assert not download_models.PRETRAINED_DIR.exists()
    finally:
        download_models.TTS_DIR, download_models.PRETRAINED_DIR = original


@pytest.mark.asyncio
@pytest.mark.parametrize("engine,source", [
    ("../outside", "org/model"),
    ("C:\\outside", "org/model"),
    ("asr", "../../outside"),
    ("asr", "org\\..\\outside"),
    ("asr", "https://other.invalid/model"),
])
async def test_download_skill_rejects_paths_before_writing_or_requesting(monkeypatch, tmp_path, engine, source):
    from app import config
    from app.core.skill_registry import _skill_download_model
    models = tmp_path / "not-yet-created-models"
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(models_dir=models))
    factory = MagicMock()
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=factory))
    result = await _skill_download_model(engine=engine, source=source)
    assert not result.success
    factory.assert_not_called()
    assert not models.exists()


@pytest.mark.asyncio
async def test_download_skill_accepts_managed_models_outside_project(monkeypatch, tmp_path):
    from app import config
    from app.core import skill_registry
    models, cache = tmp_path / "managed/models", tmp_path / "managed/cache/huggingface/hub"
    monkeypatch.setattr(skill_registry, "PROJECT_ROOT", tmp_path / "app")
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(models_dir=models))
    monkeypatch.setenv("HF_HUB_CACHE", str(cache))
    factory = MagicMock(return_value="unused")
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=factory))
    result = await skill_registry._skill_download_model(engine="asr", source="https://huggingface.co/org/model.git")
    assert result.success
    factory.assert_called_once_with(repo_id="org/model", local_dir=str(models / "asr/org_model"), local_dir_use_symlinks=False, cache_dir=str(cache))
