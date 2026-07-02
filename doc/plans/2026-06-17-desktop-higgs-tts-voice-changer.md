# 桌面端 Higgs TTS 与变声器功能 Plan

## 任务目标

- 在 `~/AI/asrapp` 桌面前端新增独立的变声器/TTS 工作台。
- 支持三种用法：
  - 语音输入，后端 VAD 结束后走 ASR，再走 Higgs TTS 返回音频。
  - 文本输入，直接调用 Higgs v3 TTS 合成音频。
  - 实时 ASR，并在每个最终识别片段后实时触发 Higgs TTS。
- 前后端记录 ASR、TTS、网络、端到端等每个环节延迟，并在前端展示。
- 前端支持选择音频输出设备，便于输出到 VB 等虚拟声卡。
- Higgs TTS 模型独立部署，默认地址为 `http://localhost:8002`。

## 影响范围分析

- 后端：
  - `backend/app/api/v1/tts_api.py`：新增 Higgs 代理、文本 TTS、语音 ASR→TTS 管线。
  - `backend/app/api/router.py`：继续挂载现有 TTS router，无需新增 router 文件。
- 前端：
  - `frontend/desktop/src/pages/VoiceChanger.tsx`：重做页面，覆盖三种模式、延迟表、音频输出设备。
  - `frontend/desktop/src/services/api.ts`：新增 Higgs TTS 类型与 API 方法。
  - `frontend/desktop/src/services/audio.ts`：补充输出设备枚举与可选播放设备设置。
  - `frontend/desktop/src/store/useASRStore.ts`：持久化 Higgs TTS 配置。
  - `frontend/desktop/src/styles/global.css`：新增紧凑工作台样式。
- 文档：
  - 新增 `doc/README.md`、`doc/CHANGELOG.md` 和 `doc/desktop/` 专题文档。

## 实现步骤

1. 增加后端 Higgs 客户端辅助方法，调用 `/health`、`/v1/audio/voices`、`/v1/audio/speech`。
2. 增加后端接口：
   - `GET /v1/tts/higgs/health`
   - `GET /v1/tts/higgs/voices`
   - `POST /v1/tts/higgs/speak`
   - `POST /v1/tts/higgs/audio-to-speech`
   - `WS /v1/tts/higgs/stream`
3. 前端 API 层补充对应类型和方法，并从响应 header 读取后端返回的延迟指标。
4. 重做 `VoiceChangerPage`：
   - 文本 TTS 模式，直接调用后端 Higgs 代理。
   - 后端 WebSocket VAD→ASR→TTS 模式，由后端返回 TTS 音频。
   - 上传音频后 ASR→TTS 模式。
   - WebSocket 实时 ASR→TTS 模式，由后端对每个 final ASR 片段触发 Higgs TTS。
   - 输出设备选择与播放。
5. 增加端到端验证脚本：
   - 使用本地假 Higgs 服务验证 health、voices、文本 TTS、音频 ASR→TTS header/timing。
   - 使用后端 test client 验证组合 WebSocket 的 ready/final/tts/done 事件链路。
   - 使用前端类型检查和生产构建验证页面、输出设备和三模式编译路径。
6. 更新持久化 settings 版本和 normalize 逻辑。
7. 更新 CHANGELOG 与桌面端文档。
8. 执行 TypeScript、Vite、Python 编译和端到端验证脚本。

## 风险评估

- Higgs v3 服务接口如果和本地 `webui.py` 不一致，TTS 代理会返回 Higgs 原始错误；默认按 `/v1/audio/speech` 兼容实现。
- 浏览器音频输出设备选择依赖 `HTMLMediaElement.setSinkId`，部分平台可能不支持；前端需要降级为系统默认输出。
- 实时 ASR→TTS 的 TTS 合成是片段级触发，不是音频 token 级低延迟流式播放；这样能复用当前后端 VAD/ASR 会话并控制复杂度。
- 本地 ASR 模型未加载时，语音管线会失败，但错误应在页面中清晰展示。

## 执行偏离记录

- 原计划将录音和上传统一走 `/v1/tts/higgs/audio-to-speech`。实现时将录音改为复用 `/v1/stream` 的后端 VAD 一句话模式，收到最终 ASR 片段后再调用 Higgs TTS，以匹配“后端 VAD 结束后过 ASR 再过 TTS”的需求；上传音频仍保留完整文件管线。
- 复查后发现“一句话模式”仍由前端触发 TTS，不够严格。继续补 `WS /v1/tts/higgs/stream`，由后端在 final ASR 事件后直接调用 Higgs 并返回音频和 timing。
