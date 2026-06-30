# 模型管理稳定性与 CUDA 运行环境

> **父文档**: [← 返回桌面端](README.md)
> **子文档**: [X-ASR 接入](../asrapp/asr/X_ASR.md) | [测试报告](../reports/2026-06-20-asr-hotwords-remote-tts-debug-test-report.md)

## 统一润色/翻译设置

模型管理把原“大模型设置”和“翻译模型设置”合并为“润色/翻译设置”。两种任务共用厂商、接口地址、模型和 API Token，通过 Prompt 区分纠错、改写或翻译；目标语言与风格是同一配置的补充字段。旧版独立翻译字段保留在持久化类型中用于兼容读取，但不再形成第二套 UI 和请求配置。

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
cd /home/yami/AI/asrapp
scripts/install_x_asr_cuda.sh
.venv/bin/python scripts/verify_x_asr_cuda.py
```

项目通用 lockfile 保留跨平台 CPU 依赖，因此启动已安装 CUDA wheel 的本机后端时使用：

```bash
cd /home/yami/AI/asrapp/backend
uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

X-ASR 在请求 CUDA 但检测到 CPU-only sherpa wheel 时会直接报错，不再静默回退并向 UI 假报 CUDA。

本机 Miniconda 的 `libstdc++` ABI 较旧，backend package 会优先加载系统 `libstdc++.so.6`。CUDA 运行库目录通过 `X_ASR_CUDA_LIBRARY_PATH` 配置；当前 `.env` 指向本机已有的 NVIDIA CUDA 12/cuDNN 9 库。
