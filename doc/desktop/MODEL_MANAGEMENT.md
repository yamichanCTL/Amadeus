# 模型管理稳定性与 CUDA 运行环境

> **父文档**: [← 返回桌面端](README.md)
> **子文档**: [X-ASR 接入](../asrapp/asr/X_ASR.md) | [测试报告](../reports/2026-06-20-asr-hotwords-remote-tts-debug-test-report.md)

## LLM 设置

模型管理把原“润色/翻译设置”更名为“LLM 设置”。该页只管理厂商、接口地址、模型和 API Token，不再重复展示 Prompt、“转写完成后自动执行”、目标语言或风格补充。Prompt 卡片和自动执行开关全部位于语音识别页，自动与手动处理读取同一张当前卡片。

## 后端驱动的 ASR 模型发现

ASR 模型行和离线/实时下拉不再维护前端引擎枚举。页面刷新时读取 `/v1/models`，根据每个模型的 `extra.model_modes`（`offline` / `streaming`）生成列表和“设为离线/实时”操作；旧后端只返回 `supports_streaming` 时仍有兼容回退。未知新引擎使用后端 `model_name`、`device` 和 `compute_type` 生成初始配置，Zustand 规范化也会保留动态配置键。

因此后端注册新 ASR engine 并正确返回能力元数据后，桌面端无需再修改引擎枚举或流式引擎判断。

## `signal is aborted without reason`

旧版模型列表请求固定在 8 秒后调用不带 reason 的 `AbortController.abort()`。Electron/Chromium 会把它直接格式化为 `signal is aborted without reason`。React StrictMode 的首次双 effect、切换后端地址或连续点击刷新会增加出现次数，但模型之间没有共享 signal。

当前实现：

- GET `/v1/models` 超时为 20 秒，超时原因明确；
- 页面只保留一个刷新 controller，新刷新会取消旧刷新；
- 被替代和页面卸载的取消不显示为错误；
- 调试台把正常取消记为 `info`，网络失败和超时仍记为 `error`；
- 模型加载/卸载期间禁用所有模型生命周期按钮，避免多模型同时占用 GPU。

这不是 ASR 引擎之间的 signal 冲突。signal 只属于一次模型列表 HTTP 请求；真正需要串行化的是 GPU 模型加载/卸载，页面已为此增加全局操作锁。

## ASR 默认 CUDA

本机 `.env` 的五个 ASR 默认设备均为 CUDA：FireRed/Whisper/X-ASR 使用 `cuda`，SenseVoice/Qwen 使用 `cuda:0`，Whisper 使用 `float16`。修改 `.env` 后必须重启后端，因为模型管理器是进程内单例。

## X-ASR CUDA

本机使用官方 `sherpa-onnx 1.13.2+cuda12.cudnn9`。安装与验证：

```bash
cd ~/AI/asrapp
scripts/install_x_asr_cuda.sh
.venv/bin/python scripts/verify_x_asr_cuda.py
```

项目通用 lockfile 保留跨平台 CPU 依赖，因此启动已安装 CUDA wheel 的本机后端时使用：

```bash
cd ~/AI/asrapp/backend
uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

X-ASR 在请求 CUDA 但检测到 CPU-only sherpa wheel 时会直接报错，不再静默回退并向 UI 假报 CUDA。

本机 Miniconda 的 `libstdc++` ABI 较旧，backend package 会优先加载系统 `libstdc++.so.6`。CUDA 运行库目录通过 `X_ASR_CUDA_LIBRARY_PATH` 配置；当前 `.env` 指向本机已有的 NVIDIA CUDA 12/cuDNN 9 库。
