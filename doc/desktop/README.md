# 桌面端

> **父文档**: [← 返回文档索引](../README.md)
> **子文档**:
> - [输入、浮窗与跨应用注入](INPUT_AND_OVERLAYS.md)
> - [桌面语音识别](SPEECH_RECOGNITION.md)
> - [Higgs TTS 与变声器](TTS_VOICE.md)
> - [远程 Higgs TTS 与开发调试台](REMOTE_TTS_AND_DEBUG.md)
> - [模型管理稳定性与 CUDA](MODEL_MANAGEMENT.md)
> - [当日总结、数据留存与桌面生命周期](SUMMARY_PRIVACY_AND_LIFECYCLE.md)
> - [ASR 立即回填与纯麦克风采集测试报告](../reports/2026-06-28-asr-fill-pure-mic-test-report.md)
> - [连续离线 ASR 自动回填延迟测试报告](../reports/2026-06-29-consecutive-offline-asr-fill-latency-report.md)
> - [麦克风收音连续性测试报告](../reports/2026-06-29-microphone-capture-continuity-report.md)
> - [桌面 ASR 交互与自适应 UI 验证报告](../reports/2026-06-30-desktop-asr-ui-e2e-report.md)
> - [总结、隐私、模型、退出与输入验证报告](../reports/2026-07-02-desktop-summary-privacy-model-exit-input-report.md)
> - [润色归档、Both 总结与紧凑窗口验证报告](../reports/2026-07-02-archive-polish-both-summary-compact-window-report.md)
> - [总结持久化、Prompt 卡片与分页设置验证报告](../reports/2026-07-03-summary-prompt-cards-settings-pages-report.md)
> - [桌面归档、总结来源、结果回填与 Qwen3-ASR 验证报告](../reports/2026-07-04-desktop-archive-summary-autofill-qwen-report.md)
> - [总结全流式、同目录归档、ASR 回填与关闭选择验证报告](../reports/2026-07-04-summary-stream-archive-close-dialog-report.md)

## 范围

桌面端位于 `frontend/desktop`，使用 Electron + React + Vite + TypeScript。它通过 `backend/app` 的 `/v1` API 访问 ASR、LLM、Agent、TTS 和变声器能力。

## 功能入口

- `实时对话`：连续语音 Agent 与本地工具编排。
- `语音识别`：文件待确认识别、录音和实时字幕。
- `变声器/TTS`：语音转 TTS、文字 TTS、实时 ASR+TTS、音效和麦克风/虚拟声卡中转混音。
- `模型管理`：离线/实时 ASR、热词、统一的 LLM 连接和本地/Boson TTS 配置。
- `开发调试台`：HTTP、WebSocket、ASR 和 TTS 延时、错误与 JSON 导出。
- `设置`：按常规、音频、识别与字幕、数据与隐私四页管理用户 ID、后端地址、音频设备、字幕、触发方式和本机保存目录。

## 相关文档

- [Higgs TTS 与变声器](TTS_VOICE.md)
- [桌面语音识别](SPEECH_RECOGNITION.md)
- [远程 Higgs TTS 与开发调试台](REMOTE_TTS_AND_DEBUG.md)
- [模型管理稳定性与 CUDA](MODEL_MANAGEMENT.md)
- [输入、浮窗与跨应用注入](INPUT_AND_OVERLAYS.md)
- [当日总结、数据留存与桌面生命周期](SUMMARY_PRIVACY_AND_LIFECYCLE.md)
- [ASR 立即回填与纯麦克风采集测试报告](../reports/2026-06-28-asr-fill-pure-mic-test-report.md)
- [连续离线 ASR 自动回填延迟测试报告](../reports/2026-06-29-consecutive-offline-asr-fill-latency-report.md)
- [麦克风收音连续性测试报告](../reports/2026-06-29-microphone-capture-continuity-report.md)
- [桌面 ASR 交互与自适应 UI 验证报告](../reports/2026-06-30-desktop-asr-ui-e2e-report.md)
- [总结、隐私、模型、退出与输入验证报告](../reports/2026-07-02-desktop-summary-privacy-model-exit-input-report.md)
- [润色归档、Both 总结与紧凑窗口验证报告](../reports/2026-07-02-archive-polish-both-summary-compact-window-report.md)
- [桌面归档、总结来源、结果回填与 Qwen3-ASR 验证报告](../reports/2026-07-04-desktop-archive-summary-autofill-qwen-report.md)
- [总结全流式、同目录归档、ASR 回填与关闭选择验证报告](../reports/2026-07-04-summary-stream-archive-close-dialog-report.md)
- [ASRAPP Frontend 桌面端](../asrapp/frontend/DESKTOP.md)
