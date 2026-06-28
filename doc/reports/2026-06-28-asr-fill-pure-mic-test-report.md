# ASR 立即回填与纯麦克风采集测试报告

> **父文档**: [← 返回桌面端](../desktop/README.md)
> **相关计划**: [ASR 立即回填与 TTS 纯麦克风采集修复](../plans/2026-06-28-fix-asr-immediate-fill-pure-mic-capture.md)

## 验证结论

- 语音转 TTS 已拆分为 ASR 和 TTS 两个请求；ASR 文本不再等待完整 TTS 音频响应。
- 220 ms ASR 响应模拟下，从停止录音到 React DOM 显示文本为 368 ms，低于 500 ms 门槛。
- 30 轮连续前端回填压力测试全部低于 500 ms：p50 5.7 ms、p95 7.4 ms、max 7.9 ms。
- 离线 ASR、语音转 TTS、实时 ASR 在 relay 激活时均保持所选实体麦克风直采，未调用 relay 输入克隆。
- 本地真实链路使用 Higgs 生成的 WAV，SenseVoice warm 请求返回准确文本，HTTP 总耗时 222.5 ms；首次冷加载为 10.356 s，不纳入 warm-path 500 ms 前端回填门槛。

## 自动化结果

```text
专项 React/输入隔离：5 passed
前端全量：39 passed
Renderer TypeScript：passed
Electron TypeScript：passed
Vite production build：passed
后端 test_higgs_tts_api + test_api：18 passed
```

## 真实模型样本

```text
输入文本：这是端到端语音识别延迟测试。
Higgs 生成：HTTP 200，2.933 s，172844 bytes
SenseVoice warm：HTTP 200，0.2225 s
识别文本：这是端到端语音识别延迟测试。
```

## 环境边界

当前 Linux/WSL 环境无法替代 Windows 实体麦克风、VB-Cable 和 QQ 输入框硬件验收。代码与自动化已验证输入源边界；Windows 上仍应使用 `./scripts/test_asr_fill_mic_isolation.sh` 加一次实际麦克风录音试听，确认驱动没有独占限制。

后端完整 `backend/tests` 在本环境执行 90 秒后停在第三个 TestClient 用例且无新增输出，已主动中止；与本次接口直接相关的 `test_higgs_tts_api.py` 和 `test_api.py` 共 18 项已单独通过。本次生产代码变更仅涉及桌面前端，未修改后端。
