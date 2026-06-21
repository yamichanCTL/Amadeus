from __future__ import annotations

from app.core.model_errors import ModelRuntimeError, classify_model_error


def test_cudnn_version_mismatch_is_reported_as_model_not_loaded() -> None:
    raw = RuntimeError("CUDNN failure 1002: CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH")

    failure = classify_model_error(raw, "x-asr")
    event = failure.as_event(session_id="session-1")

    assert isinstance(failure, ModelRuntimeError)
    assert failure.code == "model_not_loaded"
    assert failure.user_message == "模型没有加载：x-asr CUDA/cuDNN 运行库版本不兼容。"
    assert "CUDNN_STATUS" not in event["message"]
    assert event == {
        "type": "error",
        "code": "model_not_loaded",
        "message": failure.user_message,
        "model": "x-asr",
        "fatal": True,
        "session_id": "session-1",
    }


def test_cuda_oom_is_reported_as_gpu_out_of_memory() -> None:
    raw = RuntimeError("CUDA out of memory. Tried to allocate 512.00 MiB")

    failure = classify_model_error(raw, "x-asr")

    assert failure.code == "gpu_out_of_memory"
    assert failure.user_message.startswith("显存不足：")
    assert failure.as_event()["fatal"] is True
