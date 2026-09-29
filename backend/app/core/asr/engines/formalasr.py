"""FormalASR: one-model Chinese speech-to-written-text transcription."""

from __future__ import annotations

from typing import Any

from app.config import get_settings
from app.core.asr.base import ASRResult, EngineOptions
from app.core.asr.engines.qwen3asr import Qwen3ASREngine, _qwen_language


class FormalASREngine(Qwen3ASREngine):
    """Use the author's qwen-asr inference API with separate FormalASR weights.

    The model can omit and rewrite spoken tokens. Its output is consequently
    not a verbatim transcript and must not be presented as word-aligned text.
    This adapter supports completed recordings, not incremental decoding.
    """

    ENGINE_NAME = "formalasr"
    ENGINE_LABEL = "FormalASR"
    INSTALL_EXTRA = "formalasr"

    def __init__(
        self,
        model_name: str | None = None,
        model_dir: str | None = None,
        device: str | None = None,
        torch_dtype: str | None = None,
        max_new_tokens: int | None = None,
        **extra: Any,
    ) -> None:
        settings = get_settings()
        name = model_name or settings.default_formalasr_model
        self._max_new_tokens = (
            settings.formalasr_max_new_tokens if max_new_tokens is None else max_new_tokens
        )
        if not isinstance(self._max_new_tokens, int) or not 64 <= self._max_new_tokens <= 8192:
            raise ValueError("FormalASR max_new_tokens must be an integer between 64 and 8192.")
        # Rewritten text is not suitable for a forced word aligner.
        if extra.get("forced_aligner") is not None:
            raise ValueError("FormalASR does not support forced-alignment timestamps.")
        extra.setdefault("max_inference_batch_size", 1)
        super().__init__(
            model_name=name,
            model_dir=model_dir or str(settings.formalasr_model_path(name)),
            device=device or settings.default_formalasr_device,
            torch_dtype=torch_dtype or settings.formalasr_torch_dtype,
            max_new_tokens=self._max_new_tokens,
            **extra,
        )

    def _call_model(self, audio_path: str, opts: EngineOptions) -> Any:
        if opts.task != "transcribe":
            raise ValueError("FormalASR supports Chinese written transcription, not translation.")
        language = _qwen_language(opts.language)
        if language and language.lower() not in {"chinese", "auto"}:
            raise ValueError("FormalASR is a Chinese speech-to-written-text model; use language='zh'.")
        # Follow the model author's inference recipe. Do not turn user prompts
        # or hotwords into an undocumented instruction-following capability.
        return self._model.transcribe(
            audio=audio_path,
            language="Chinese",
            return_time_stamps=False,
        )

    def _run_inference(self, audio_bytes: bytes, opts: EngineOptions) -> ASRResult:
        result = super()._run_inference(audio_bytes, opts)
        result.segments = []
        result.language = "zh"
        result.raw.update(
            output_kind="written_text",
            native_punctuation=True,
            supports_timestamps=False,
        )
        return result

    def info(self) -> dict[str, Any]:
        info = super().info()
        info.update(
            languages=["zh"],
            output_kind="written_text",
            native_punctuation=True,
            supports_timestamps=False,
            max_new_tokens=self._max_new_tokens,
            description="中文语音直接输出书面文本，离线识别；不提供逐字时间戳。",
        )
        return info
