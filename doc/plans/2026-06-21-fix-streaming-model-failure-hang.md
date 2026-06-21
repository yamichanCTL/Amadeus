# 修复流式模型失败后 WebSocket 卡死

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **相关文档**: [Backend 流式识别](../asrapp/backend/STREAMING.md)

## 任务目标

修复实时 ASR 在模型未真正可用、CUDA/cuDNN 运行时异常或显存不足时只记录底层异常、随后连接卡住的问题。后端必须向客户端返回稳定的中文错误和机器可读错误码，并立即结束失败会话。

## 影响范围

- `backend/app/core/model_errors.py`：模型运行异常分类和对外错误事件。
- `backend/app/core/asr/engines/x_asr.py`：加载阶段执行真实 warm-up，推理失败后撤销 loaded 状态。
- `backend/app/core/streaming/session.py`：记录致命模型失败并提供不再调用失败 decoder 的中止路径。
- `backend/app/api/v1/stream.py`、`backend/app/api/v1/tts_api.py`：发送结构化错误并关闭 WebSocket。
- `backend/tests/`：覆盖 cuDNN 不兼容、OOM、warm-up 失败和会话中止。
- `doc/asrapp/backend/STREAMING.md`、`doc/CHANGELOG.md`：同步协议与变更记录。

## 实现步骤

1. 将模型异常归一为 `model_not_loaded` 或 `gpu_out_of_memory`，不向客户端直接透传 ONNX/CUDA 堆栈。
2. X-ASR 构造 recognizer 后用静音帧执行一次真实 decode；warm-up 成功后才设置 `is_loaded=true`。
3. 运行期 decode 失败时立刻清除 engine 的 recognizer 引用，使模型不再保持假 ready 状态。
4. 流式 session 标记致命错误；WebSocket sender 发送错误后主动关闭连接，中止路径丢弃失败 decoder，不再次执行 `finish()`。
5. 对原生 ASR 和 ASR→Higgs 两条 WebSocket 通路采用同一错误协议，并运行针对性测试。

## 风险评估

- 首次 X-ASR 加载增加一次短静音 warm-up，启动耗时略增，但可在采集前发现 CUDA/OOM 问题。
- native CUDA 调用无法被 Python 强制终止；中止逻辑只能保证后端不再次调用已失败 decoder，并立即关闭当前 WebSocket。
- 当前工作树已有大量未提交改动，本次只做局部补丁，不覆盖或回退现有内容。
