"""
GPT-SoVITS pretrained model downloader.
Downloads base models from HuggingFace for local TTS.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

TTS_DIR = Path(__file__).resolve().parents[5] / "tts"
PRETRAINED_DIR = TTS_DIR / "pretrained_models"

# Models required for GPT-SoVITS to work
# v3 = latest, v1/v2 = stable fallback
PRETRAINED_MODELS = {
    # GPT models (S1 - text-to-speech-token)
    "s1v3.ckpt": {
        "url": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s1v3.ckpt",
        "size_mb": 155,
        "required": True,
        "description": "GPT model v3 (recommended)",
    },
    "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt": {
        "url": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s1bert25hz-2kh-longer-epoch%3D68e-step%3D50232.ckpt",
        "size_mb": 155,
        "required": False,
        "description": "GPT model v1 (stable fallback)",
    },
    # SoVITS models (S2 - token-to-audio)
    "s2Gv3.pth": {
        "url": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s2Gv3.pth",
        "size_mb": 769,
        "required": True,
        "description": "SoVITS generator v3 (recommended)",
    },
    "s2G488k.pth": {
        "url": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s2G488k.pth",
        "size_mb": 106,
        "required": False,
        "description": "SoVITS generator v1 (stable fallback)",
    },
    "s2D488k.pth": {
        "url": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s2D488k.pth",
        "size_mb": 94,
        "required": False,
        "description": "SoVITS discriminator v1 (for training only)",
    },
}


def get_model_status() -> dict[str, dict]:
    """Check which models are downloaded."""
    status = {}
    for name, info in PRETRAINED_MODELS.items():
        path = PRETRAINED_DIR / name
        status[name] = {
            **info,
            "downloaded": path.exists(),
            "size_on_disk_mb": round(path.stat().st_size / (1024 * 1024), 1) if path.exists() else 0,
        }
    return status


async def download_model(name: str) -> dict:
    """Download a single pretrained model."""
    if name not in PRETRAINED_MODELS:
        return {"success": False, "error": f"Unknown model: {name}"}

    info = PRETRAINED_MODELS[name]
    path = PRETRAINED_DIR / name

    if path.exists():
        return {"success": True, "model": name, "status": "already downloaded", "path": str(path)}

    PRETRAINED_DIR.mkdir(parents=True, exist_ok=True)

    logger.info("Downloading %s (%d MB)...", name, info["size_mb"])
    try:
        async with httpx.AsyncClient(timeout=600.0, follow_redirects=True) as client:
            response = await client.get(info["url"])
            response.raise_for_status()

            # Stream write
            path.write_bytes(response.content)

        actual_mb = round(path.stat().st_size / (1024 * 1024), 1)
        logger.info("Downloaded %s (%d MB)", name, actual_mb)
        return {"success": True, "model": name, "size_mb": actual_mb, "path": str(path)}
    except Exception as e:
        # Clean up partial download
        if path.exists():
            path.unlink()
        return {"success": False, "model": name, "error": str(e)}


async def download_required_models() -> dict:
    """Download all required pretrained models. Returns status dict."""
    results = {}
    total_size = 0

    for name, info in PRETRAINED_MODELS.items():
        if info["required"]:
            result = await download_model(name)
            results[name] = result
            if result["success"]:
                total_size += result.get("size_mb", info["size_mb"])

    all_ok = all(r.get("success") for r in results.values())
    return {
        "success": all_ok,
        "models": results,
        "total_size_mb": round(total_size, 1),
        "output_dir": str(PRETRAINED_DIR),
    }
