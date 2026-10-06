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


def test_missing_runtime_dependency_keeps_a_concrete_recovery_message() -> None:
    try:
        try:
            raise ModuleNotFoundError("No module named 'qwen_asr'")
        except ModuleNotFoundError as missing:
            raise RuntimeError("FormalASR requires qwen-asr. Install its runtime extra.") from missing
    except RuntimeError as exc:
        failure = classify_model_error(exc, "formalasr")

    assert failure.code == "runtime_dependency_missing"
    assert "安装运行组件" in failure.user_message
    assert "识别配置 → 模型下载" in failure.user_message
    assert "无需重新下载" in failure.user_message
    assert "qwen_asr" in failure.detail
    assert failure.as_event()["message"] == failure.user_message


def test_cpu_torch_with_explicit_cuda_request_explains_device_selection() -> None:
    failure = classify_model_error(RuntimeError("Torch not compiled with CUDA enabled"), "formalasr")
    assert failure.code == "gpu_not_available"
    assert "CPU" in failure.user_message
    assert "CUDA 版运行组件" in failure.user_message
