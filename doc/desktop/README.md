# 桌面端

> **父文档**: [← 返回文档索引](../README.md)
> **子文档**:
> - [Higgs TTS 与变声器](TTS_VOICE.md)

## 范围

桌面端位于 `frontend/desktop`，使用 Electron + React + Vite + TypeScript。它通过 `backend/app` 的 `/v1` API 访问 ASR、LLM、Agent、TTS 和变声器能力。

## 功能入口

- `实时对话`：连续语音 Agent 与本地工具编排。
- `文件转写`：文件、录音和实时字幕。
- `变声器/TTS`：语音转 TTS、文字 TTS、实时 ASR+TTS 和输出设备选择。
- `模型管理`：ASR、LLM、翻译和 TTS 模型配置；TTS 设置包含 Higgs API 地址、音色和生成参数。
- `设置`：后端地址、音频输入、字幕和触发方式。

## 相关文档

- [Higgs TTS 与变声器](TTS_VOICE.md)
- [ASRAPP Frontend 桌面端](../asrapp/frontend/DESKTOP.md)
