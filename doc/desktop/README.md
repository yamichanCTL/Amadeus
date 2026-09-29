# 桌面端

> **父文档**: [← 返回文档索引](../README.md)
> **子文档**:
> - [Windows 一键安装与启动](windows-quick-start.md)
> - [模型智能下载](model-downloads.md)
> - [爱弥斯 Windows 3D 桌宠](AEMEATH_PET.md)
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
> - [桌面总结、ASR 回填、关闭策略与长音频验证报告](../reports/2026-07-06-desktop-summary-input-lifecycle-long-audio-report.md)

## 范围

桌面端位于 `frontend/desktop`，使用 Electron + React + Vite + TypeScript。它通过 `backend/app` 的 `/v1` API 访问 ASR、LLM、Agent、TTS 和变声器能力。

## 功能入口

- `实时对话`：连续语音 Agent 与本地工具编排。
- `爱弥斯桌宠`：在实时对话的 Agent 设定中开启 Windows 透明 3D 角色，共用 ASR、Agent 和 TTS 会话。
- `语音识别`：文件待确认识别、录音和实时字幕。
- `变声器/TTS`：语音转 TTS、文字 TTS、实时 ASR+TTS、音效和麦克风/虚拟声卡中转混音。
- `模型管理`：离线/实时 ASR、热词、统一的 LLM 连接和本地/Boson TTS 配置。
- `开发调试台`：HTTP、WebSocket、ASR 和 TTS 延时、错误与 JSON 导出。
- `设置`：按常规、音频、识别与字幕、数据与隐私四页管理用户 ID、后端地址、音频设备、字幕、触发方式和本机保存目录。

## 爱弥斯 3D 实时对话

`实时对话`页面和透明置顶桌宠共享用户导入的本地 GLB 模型。具备对应骨骼与形态键的模型可随监听、思考和实际播放音频切换动作与口型。公开版本不附带第三方角色资产；没有模型也可使用语音功能。

Windows 安装包包含前端和后端源码，可在设置中一键安装专用 Python 与基础依赖，并启动本机后端。无需 Linux；也可以连接已有后端。源码开发仍可使用 `scripts/start_amadeus_backend.ps1`，脚本只监听 `127.0.0.1`，日志位于 `.runtime`。

页面的实时语音模式可选择 OpenAI GPT-Live 或千问 Realtime，使用 WebRTC 同时收音与播放；后台只负责将 SDP offer 交换为 answer，并保存服务商密钥。现在密钥留空，选择实时服务商时会显示未配置，且不会创建付费会话。决定服务商后，在 `backend/.env` 填写 `OPENAI_API_KEY`，或填写 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID` 和地域设置。不要将密钥放在前端或提交到仓库。

实时会话可把需要深入处理的问题委派给本地 Codex。`允许执行本地任务`默认关闭；开启后每次委派都要在桌面端确认。当前 Windows Codex 运行时的任务模式使用当前用户权限运行命令，确认对话框会明确提示这一点。未开启时只进行只读分析。

## 相关文档

- [爱弥斯 Windows 3D 桌宠](AEMEATH_PET.md)
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
- [桌面总结、ASR 回填、关闭策略与长音频验证报告](../reports/2026-07-06-desktop-summary-input-lifecycle-long-audio-report.md)
- [ASRAPP Frontend 桌面端](../asrapp/frontend/DESKTOP.md)
