"""Stable, user-facing classification for local model runtime failures."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

_OOM_MARKERS = (
    "out of memory",
    "cuda_error_out_of_memory",
    "cudnn_status_alloc_failed",
    "cublas_status_alloc_failed",
    "failed to allocate memory",
    "failed to allocate cuda",
    "bfcarena::alloc",
    "std::bad_alloc",
)
_CUDA_VERSION_MARKERS = (
    "cudnn_status_sublibrary_version_mismatch",
    "cudnn_status_version_mismatch",
    "cudnn version mismatch",
    "cudnn library",
    "cuda runtime libraries are missing",
    "cpu-only",
)
_MODEL_FILE_MARKERS = (
    "model files are missing",
    "git lfs pointers",
    "no such file or directory",
)


@dataclass
class ModelRuntimeError(RuntimeError):
    """A model failure safe to expose over HTTP/WebSocket boundaries."""

    code: str
    user_message: str
    model: str
    detail: str

    def __str__(self) -> str:
        return self.user_message

    def as_event(self, *, session_id: str | None = None) -> dict[str, Any]:
        event: dict[str, Any] = {
            "type": "error",
            "code": self.code,
            "message": self.user_message,
            "model": self.model,
            "fatal": True,
        }
        if session_id:
            event["session_id"] = session_id
        return event


def classify_model_error(exc: BaseException, model: str) -> ModelRuntimeError:
    """Map native CUDA/ONNX failures to the two supported client outcomes."""

    if isinstance(exc, ModelRuntimeError):
        return exc

    detail = _exception_chain_text(exc)
    normalized = detail.lower()
    display_name = model.strip() or "ASR"

    if any(marker in normalized for marker in _OOM_MARKERS):
        return ModelRuntimeError(
            code="gpu_out_of_memory",
            user_message=(
                f"显存不足：无法加载或运行 {display_name} 模型，"
                "请先卸载其他 GPU 模型后重试。"
            ),
            model=display_name,
            detail=detail,
        )

    if any(marker in normalized for marker in _CUDA_VERSION_MARKERS):
        reason = "CUDA/cuDNN 运行库版本不兼容"
    elif any(marker in normalized for marker in _MODEL_FILE_MARKERS):
        reason = "模型文件缺失或不完整"
    else:
        reason = "模型初始化或推理失败"
    return ModelRuntimeError(
        code="model_not_loaded",
        user_message=f"模型没有加载：{display_name} {reason}。",
        model=display_name,
        detail=detail,
    )


def _exception_chain_text(exc: BaseException) -> str:
    parts: list[str] = []
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        text = str(current).strip()
        if text:
            parts.append(text)
        current = current.__cause__ or current.__context__
    return " | ".join(parts) or type(exc).__name__
