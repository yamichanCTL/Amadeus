# 修复模型管理请求取消与 X-ASR CUDA 验证计划

日期：2026-06-20

## 目标

- 定位并消除模型管理中频繁出现的 `signal is aborted without reason`。
- 避免 React StrictMode、页面重载、手动刷新和模型加载后的刷新相互覆盖。
- 给请求超时、主动取消、后端不可达分别提供明确提示，不把正常取消显示为错误。
- 安装并验证 sherpa-onnx 官方 CUDA wheel，使 X-ASR 不再静默回退 CPU。
- 更新测试报告、CHANGELOG 和模型管理文档。

## 影响范围

- `frontend/desktop/src/services/api.ts`：可识别原因的超时和取消错误。
- `frontend/desktop/src/pages/Models.tsx`：刷新请求去重、取消和卸载清理。
- `frontend/desktop/src/services/telemetry.ts`：正常取消与真实失败区分。
- `backend/app/core/asr/engines/x_asr.py`：CUDA provider 可用性和实际运行状态检查。
- `backend/tests/`、`frontend/desktop/`、`doc/`：回归测试和文档。

## 实施步骤

1. 复现并确认错误来自 `/v1/models` 的 8 秒 `AbortController`，检查是否存在共享 signal 或并发冲突。
2. 为 API 请求增加显式 `TimeoutError`，模型列表请求支持外部 signal，并将取消原因标准化。
3. 模型管理用单一 refresh controller 管理生命周期；新刷新取消旧刷新，正常 superseded/unmount 取消不显示错误。
4. 遥测将取消记为 info，将超时和网络错误记为 error。
5. 检查 CUDA、cuDNN、Python ABI，下载匹配的官方 sherpa-onnx CUDA wheel并安装。
6. 真实加载 X-ASR，检查运行日志、GPU 进程/显存和 partial/final；禁止把 CPU fallback 报告为 CUDA 成功。
7. 执行后端定向测试、真实音频测试、TypeScript、Vite/Electron 和文档构建。
8. 更新测试报告、CHANGELOG 和模型管理故障排查文档。

## 风险

- CUDA wheel 约 190 MB，必须匹配 Python 3.13、Linux x86_64、CUDA/cuDNN ABI。
- 模型列表刷新取消不能误伤模型加载/卸载请求；controller 只作用于 GET `/v1/models`。
- Electron 和浏览器对无 reason 的 AbortError 文案不同，不能直接展示原始异常。
