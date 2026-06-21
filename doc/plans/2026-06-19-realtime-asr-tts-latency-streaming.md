# 实时 ASR + TTS 端到端流式延迟优化

## 任务目标

- 将实时 ASR + TTS 链路从“ASR 分段 + TTS 整段返回”升级为可观测的流式链路。
- 后端 WebSocket 在 ASR final 后立即启动 Higgs 流式 TTS，请求使用 `stream=true`，并把 TTS 音频按 chunk 转发给前端。
- 前端展示端到端首包延迟、TTS 总耗时，并支持边收边播放的低延迟路径。
- 保留原有完整音频事件的兼容能力，避免 Higgs 服务不支持流式响应时前端无法播放。

## 影响范围分析

- `backend/app/api/v1/tts_api.py`
  - 新增 Higgs 音频流式请求辅助函数。
  - 扩展 `/v1/tts/higgs/stream` WebSocket 事件：`tts_start`、`tts_chunk`、`tts_done`，保留 `tts`。
  - 实时 TTS 配置默认开启 `stream=true` 并输出首包延迟指标。
- `frontend/desktop/src/services/audio.ts`
  - 扩展实时 TTS 事件类型与解析逻辑。
  - 新增 PCM16 chunk 播放器，用于低延迟播放 Higgs `pcm` 流。
- `frontend/desktop/src/pages/VoiceChanger.tsx`
  - 实时模式展示首包延迟、TTS 完成耗时、端到端耗时。
  - 接入 `tts_start` / `tts_chunk` / `tts_done` 事件。
- `backend/tests/test_higgs_tts_api.py`
  - 增加流式事件和配置测试。
- `doc/CHANGELOG.md` 与桌面 TTS 文档
  - 记录本次协议与使用方式变化。

## 实现步骤

1. 创建流式计划文档，明确协议、前端播放和验证范围。
2. 后端实现 Higgs HTTP chunk 读取与 WebSocket chunk 转发。
3. 前端实现事件解析、低延迟 PCM 播放和延迟展示。
4. 补充单元测试覆盖实时 TTS `stream=true` 与 chunk 事件时序。
5. 更新 `doc/CHANGELOG.md` 和桌面 TTS 文档。
6. 执行 TypeScript、Vite、Python compileall 与目标测试。

## 风险评估

- Higgs 服务如果虽然接受 `stream=true` 但仍缓冲整段响应，则首包延迟会如实反映服务端实际行为，无法仅由本项目保证低于 1 秒。
- 流式响应目前按 PCM16 单声道播放，若 Higgs 返回非 PCM chunk，前端会回退到完整音频事件播放。
- 浏览器/桌面运行时对 WebAudio 输出设备选择支持不完全一致，完整音频回放仍使用既有 `setSinkId` 路径保证输出设备兼容性。
- 本次后端使用阻塞式 urllib 按 chunk 迭代并逐块转发，优先保证 Higgs 首包能立刻送到前端且测试稳定；TTS 读取期间同一 WebSocket 连接的接收循环会短暂被占用，后续如需完全并发可替换为 aiohttp/anyio 原生异步 HTTP 客户端。
