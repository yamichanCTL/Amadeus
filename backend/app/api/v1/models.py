"""
app/api/v1/models.py
─────────────────────
Model management endpoints.

GET  /v1/models              – list all engines and their load status
POST /v1/models/{name}/load  – load (or hot-swap) an engine
POST /v1/models/{name}/unload – unload an engine and free memory
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.config import get_settings
from app.core.asr.registry import available_engines
from app.dependencies import Manager
from app.schemas.transcribe import ModelInfo, ModelsListResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/models", tags=["models"])
settings = get_settings()


# ── Request body for load / hot-swap ─────────────────────────────────────────

class LoadModelRequest(BaseModel):
    """
    Optional body for POST /v1/models/{name}/load.
    All fields are optional — omit to reload with current defaults.
    """
    model_name: str | None = None       # e.g. "large-v3" for whisper
    device: str | None = None           # "cpu" | "cuda"
    compute_type: str | None = None     # "int8" | "float16" | "float32"
    extra: dict[str, Any] = {}


# ── GET /v1/models ────────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=ModelsListResponse,
    summary="List all registered ASR engines",
)
async def list_models(manager: Manager) -> ModelsListResponse:
    """
    Return status and metadata for every registered ASR engine.

    `is_loaded: true` means the model weights are in memory and ready to
    accept inference calls without a cold-start delay.
    """
    raw_list = manager.list_engines()
    engine_infos: list[ModelInfo] = []

    for item in raw_list:
        engine_infos.append(
            ModelInfo(
                engine=item.get("engine", "unknown"),
                model_name=item.get("model_name", item.get("engine", "?")),
                is_loaded=item.get("is_loaded", False),
                device=item.get("device"),
                compute_type=item.get("compute_type"),
                languages=item.get("languages", []),
                extra={
                    k: v
                    for k, v in item.items()
                    if k not in {
                        "engine", "model_name", "is_loaded",
                        "device", "compute_type", "languages",
                    }
                },
            )
        )

    return ModelsListResponse(
        engines=engine_infos,
        default_engine=settings.default_engine,
    )


# ── POST /v1/models/{name}/load ───────────────────────────────────────────────

@router.post(
    "/{name}/load",
    response_model=ModelInfo,
    summary="Load or hot-swap an engine",
)
async def load_model(
    name: str,
    manager: Manager,
    body: LoadModelRequest | None = None,
) -> ModelInfo:
    """
    Load an engine into memory.

    If the engine is already loaded and new options are provided, it is
    hot-swapped (unloaded then reloaded with the new configuration).

    This is useful for switching Whisper model sizes without restarting
    the server:
    ```json
    POST /v1/models/whisper/load
    {"model_name": "large-v3", "device": "cuda", "compute_type": "float16"}
    ```
    """
    if name not in available_engines():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown engine '{name}'. Available: {available_engines()}",
        )

    body = body or LoadModelRequest()

    # Build kwargs for hot_swap / configure
    kwargs: dict[str, Any] = {}
    if body.model_name:
        # Map generic "model_name" to engine-specific param
        if name == "whisper":
            kwargs["model_size"] = body.model_name
        elif name == "sensevoice":
            if body.model_name == "SenseVoiceSmall":
                kwargs["model_dir"] = str(settings.sensevoice_model_dir)
            else:
                kwargs["model_dir"] = body.model_name
        elif name == "qwen3asr":
            kwargs["model_name"] = body.model_name
            if body.model_name == settings.default_qwen3asr_model:
                kwargs["model_dir"] = str(settings.qwen3asr_model_dir)
        else:
            kwargs["model_name"] = body.model_name
    if body.device:
        kwargs["device"] = body.device
    if body.compute_type:
        kwargs["compute_type"] = body.compute_type
    kwargs.update(body.extra)

    try:
        if kwargs or not manager.is_loaded(name):
            await manager.hot_swap(name, **kwargs)
        else:
            # Already loaded with same config — no-op
            logger.info("Engine '%s' already loaded, skipping reload.", name)
    except Exception as exc:
        logger.exception("Failed to load engine '%s': %s", name, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to load engine '{name}': {exc}",
        ) from exc

    engine = await manager.get_engine(name)
    info = engine.info()
    return ModelInfo(
        engine=info.get("engine", name),
        model_name=info.get("model_name", name),
        is_loaded=info.get("is_loaded", True),
        device=info.get("device"),
        compute_type=info.get("compute_type"),
        languages=info.get("languages", []),
        extra={
            k: v
            for k, v in info.items()
            if k not in {
                "engine", "model_name", "is_loaded",
                "device", "compute_type", "languages",
            }
        },
    )


# ── POST /v1/models/{name}/unload ─────────────────────────────────────────────

@router.post(
    "/{name}/unload",
    summary="Unload an engine and free its memory",
    status_code=status.HTTP_200_OK,
)
async def unload_model(name: str, manager: Manager) -> dict[str, str]:
    """
    Unload an engine from memory.

    Useful on low-RAM devices to free resources before loading a larger model.
    Any in-flight requests using this engine will fail after unloading.
    """
    if name not in available_engines():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown engine '{name}'.",
        )

    if not manager.is_loaded(name):
        return {"message": f"Engine '{name}' was not loaded."}

    await manager.unload_engine(name)
    return {"message": f"Engine '{name}' unloaded successfully."}
