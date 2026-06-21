# 桌面端

> **父文档**: [← 返回文档索引](../README.md)
> **子文档**:
> - [输入、浮窗与跨应用注入](INPUT_AND_OVERLAYS.md)
> - [桌面语音识别](SPEECH_RECOGNITION.md)
> - [Higgs TTS 与变声器](TTS_VOICE.md)
> - [远程 Higgs TTS 与开发调试台](REMOTE_TTS_AND_DEBUG.md)
> - [模型管理稳定性与 CUDA](MODEL_MANAGEMENT.md)

## 范围

桌面端位于 `frontend/desktop`，使用 Electron + React + Vite + TypeScript。它通过 `backend/app` 的 `/v1` API 访问 ASR、LLM、Agent、TTS 和变声器能力。

## 功能入口

- `实时对话`：连续语音 Agent 与本地工具编排。
- `语音识别`：文件待确认识别、录音和实时字幕。
- `变声器/TTS`：语音转 TTS、文字 TTS、实时 ASR+TTS、音效和麦克风/虚拟声卡中转混音。
- `模型管理`：离线/实时 ASR、热词、LLM、翻译和本地/Boson TTS 配置。
- `开发调试台`：HTTP、WebSocket、ASR 和 TTS 延时、错误与 JSON 导出。
- `设置`：用户 ID、后端地址、真实麦克风、虚拟麦克风输出、字幕和触发方式。

## 相关文档

- [Higgs TTS 与变声器](TTS_VOICE.md)
- [桌面语音识别](SPEECH_RECOGNITION.md)
- [远程 Higgs TTS 与开发调试台](REMOTE_TTS_AND_DEBUG.md)
- [模型管理稳定性与 CUDA](MODEL_MANAGEMENT.md)
- [输入、浮窗与跨应用注入](INPUT_AND_OVERLAYS.md)
- [ASRAPP Frontend 桌面端](../asrapp/frontend/DESKTOP.md)
