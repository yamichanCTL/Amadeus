"""
GPT-SoVITS TTS Adapter for ASRAPP
Mirrors Shinsekai's tts/tts_adapter.py GPTSoVitsAdapter pattern.

Talks to a GPT-SoVITS server (api_v2.py) running on a local port.
Supports: text-to-speech, model switching, server lifecycle.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from pathlib import Path
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

settings = get_settings()
TTS_DIR = settings.tts_data_dir
PRETRAINED_DIR = TTS_DIR / "pretrained_models"
MODELS_DIR = TTS_DIR / "models"

# HuggingFace model URLs
PRETRAINED_MODELS = {
    # v3 models (recommended - latest)
    "s1v3.ckpt": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s1v3.ckpt",
    "s2Gv3.pth": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s2Gv3.pth",
    # v1/v2 models (stable)
    "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s1bert25hz-2kh-longer-epoch%3D68e-step%3D50232.ckpt",
    "s2G488k.pth": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s2G488k.pth",
    "s2D488k.pth": "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/s2D488k.pth",
    # Chinese text processing
    "chinese-roberta-wwm-ext-large": "https://huggingface.co/lj1995/GPT-SoVITS/tree/main/chinese-roberta-wwm-ext-large",
    "chinese-hubert-base": "https://huggingface.co/lj1995/GPT-SoVITS/tree/main/chinese-hubert-base",
}


class GPTSoVITSServer:
    """Manages the GPT-SoVITS server lifecycle."""

    def __init__(
        self,
        server_url: str = "http://127.0.0.1:9880",
        gpt_sovits_path: Path | None = None,
    ):
        self.server_url = server_url.rstrip("/")
        self.gpt_sovits_path = gpt_sovits_path or settings.gpt_sovits_dir
        self._process: subprocess.Popen | None = None

    @property
    def base_url(self) -> str:
        return self.server_url + "/"

    async def is_alive(self) -> bool:
        """Check if the GPT-SoVITS server is running."""
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(self.base_url)
                return resp.status_code == 200
        except Exception:
            return False

    async def start(self) -> bool:
        """Start the GPT-SoVITS server as a subprocess."""
        if await self.is_alive():
            logger.info("GPT-SoVITS server already running at %s", self.server_url)
            return True

        if self.gpt_sovits_path is None:
            logger.error("GPT_SOVITS_DIR is not configured")
            return False
        api_path = self.gpt_sovits_path / "api_v2.py"
        if not api_path.exists():
            logger.error("GPT-SoVITS api_v2.py not found at %s", api_path)
            return False

        # Detect python interpreter
        python = os.environ.get("GPT_SOVITS_PYTHON", "python3")
        env = os.environ.copy()
        env.setdefault("PYTHONPATH", str(self.gpt_sovits_path))

        logger.info("Starting GPT-SoVITS server: %s %s", python, api_path)
        self._process = subprocess.Popen(
            [python, str(api_path)],
            cwd=str(self.gpt_sovits_path),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # Wait for server to be ready
        for _ in range(30):
            await asyncio.sleep(1)
            if await self.is_alive():
                logger.info("GPT-SoVITS server started successfully")
                return True

        logger.error("GPT-SoVITS server failed to start within 30s")
        return False

    async def stop(self) -> None:
        """Stop the GPT-SoVITS server."""
        if self._process:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
            self._process = None
            logger.info("GPT-SoVITS server stopped")


class GPTSoVITSAdapter:
    """
    Adapter for GPT-SoVITS TTS, mirroring Shinsekai's GPTSoVitsAdapter.

    Usage:
        adapter = GPTSoVITSAdapter()
        await adapter.set_model(gpt_model="s1v3.ckpt", sovits_model="s2Gv3.pth")
        result = await adapter.synthesize("你好世界", ref_audio_path="voice_sample.wav")
    """

    def __init__(self, server_url: str = "http://127.0.0.1:9880"):
        self.server = GPTSoVITSServer(server_url=server_url)
        self.gpt_model: str | None = None
        self.sovits_model: str | None = None

    async def ensure_running(self) -> bool:
        if await self.server.is_alive():
            return True
        return await self.server.start()

    async def set_model(self, gpt_model: str | None = None, sovits_model: str | None = None) -> bool:
        """Set GPT and SoVITS model weights on the server."""
        if not await self.ensure_running():
            return False

        async with httpx.AsyncClient(timeout=10.0) as client:
            if gpt_model and gpt_model != self.gpt_model:
                gpt_path = PRETRAINED_DIR / gpt_model
                if not gpt_path.exists():
                    logger.warning("GPT model not found: %s", gpt_path)
                    return False
                try:
                    resp = await client.get(
                        self.server.base_url + "set_gpt_weights",
                        params={"weights_path": str(gpt_path)},
                    )
                    resp.raise_for_status()
                    self.gpt_model = gpt_model
                    logger.info("GPT model set: %s", gpt_model)
                except Exception as e:
                    logger.error("Failed to set GPT model: %s", e)
                    return False

            if sovits_model and sovits_model != self.sovits_model:
                sovits_path = PRETRAINED_DIR / sovits_model
                if not sovits_path.exists():
                    logger.warning("SoVITS model not found: %s", sovits_path)
                    return False
                try:
                    resp = await client.get(
                        self.server.base_url + "set_sovits_weights",
                        params={"weights_path": str(sovits_path)},
                    )
                    resp.raise_for_status()
                    self.sovits_model = sovits_model
                    logger.info("SoVITS model set: %s", sovits_model)
                except Exception as e:
                    logger.error("Failed to set SoVITS model: %s", e)
                    return False

        return True

    async def synthesize(
        self,
        text: str,
        ref_audio_path: str | None = None,
        prompt_text: str = "",
        prompt_lang: str = "zh",
        text_lang: str = "zh",
        speed_factor: float = 1.0,
    ) -> bytes | None:
        """
        Synthesize speech using GPT-SoVITS.

        Args:
            text: Text to synthesize
            ref_audio_path: Path to reference audio for voice cloning (5s sample)
            prompt_text: Text of the reference audio
            prompt_lang: Language of reference audio
            text_lang: Language of text to synthesize
            speed_factor: Speech speed (0.5-2.0)

        Returns:
            WAV audio bytes or None on failure
        """
        if not await self.ensure_running():
            logger.error("GPT-SoVITS server not running")
            return None

        if not self.gpt_model or not self.sovits_model:
            logger.error("Models not set - call set_model() first")
            return None

        params: dict[str, Any] = {
            "text": text,
            "text_lang": text_lang,
            "text_split_method": "cut5",
            "batch_size": 1,
            "speed_factor": speed_factor,
        }

        if ref_audio_path:
            params["ref_audio_path"] = ref_audio_path
        if prompt_text:
            params["prompt_text"] = prompt_text
        if prompt_lang:
            params["prompt_lang"] = prompt_lang

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    self.server.base_url + "tts",
                    json=params,
                )
                resp.raise_for_status()
                return resp.content
        except Exception as e:
            logger.error("GPT-SoVITS TTS failed: %s", e)
            return None


# ── Singleton ─────────────────────────────────────────────────────────────────

_adapter: GPTSoVITSAdapter | None = None


def get_tts_adapter() -> GPTSoVITSAdapter:
    global _adapter
    if _adapter is None:
        _adapter = GPTSoVITSAdapter()
    return _adapter
