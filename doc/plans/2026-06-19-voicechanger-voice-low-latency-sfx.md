# 变声器音色即时切换、低延迟实时 TTS 与音效播放

## 任务目标

- 修复 `变声器/TTS` 页面内切换音色不生效的问题，页面内选择应立即影响文本 TTS、语音转 TTS 和实时 ASR+TTS，不再依赖模型管理页。
- 实时 ASR+TTS 从“等一句话 final 后再 TTS”改成“首个 partial 先触发流式 TTS”，目标是第一个可识别文本出现后尽快拿到 TTS 首包，并用自动化测试证明链路在 mock 环境下小于 1 秒。
- 增加音效即时播放功能：用户可以导入已有音频，点击后立即播放到当前选择的输出设备，包括 VB 等虚拟声卡。

## 影响范围分析

- `frontend/desktop/src/pages/VoiceChanger.tsx`
  - 音色选择同步写入全局设置并立即用于请求。
  - 新增音效文件列表、即时播放、移除与清空。
  - 实时模式展示 partial TTS 首包延迟。
- `frontend/desktop/src/services/audio.ts`
  - 继续复用 `playAudioBlob` 的 `setSinkId` 输出设备能力。
- `backend/app/api/v1/tts_api.py`
  - Higgs 流式请求改为异步 HTTP chunk 读取，避免阻塞 WebSocket loop。
  - 实时 WebSocket 支持 partial speculative TTS，final 只在没有 partial TTS 时触发。
- `backend/app/core/streaming/session.py`
  - 需要时调整 partial 首包阈值或事件字段，降低首个 partial 出现时间。
- `backend/tests/`
  - 覆盖 partial 触发 TTS、音色 payload 和流式首包 timing。
- 文档与 CHANGELOG
  - 记录低延迟策略、音效播放和测试边界。

## 实现步骤

1. 查明变声器音色选择只改本地 state、刷新后被全局 `higgsTtsVoice` 覆盖的问题，改为页面内选择时同步 `updateSettings`。
2. 后端新增异步 Higgs PCM stream 读取器，按上游 `webui.py` 的 PCM16 规则转发 chunk。
3. WebSocket send loop 对首个 non-empty `partial` 触发 speculative TTS；同一段语音已触发 partial TTS 时，跳过 final TTS，避免重复播报。
4. 前端实时事件展示 `source_event=partial/final` 和首包目标状态。
5. 变声器页面新增音效导入和即时播放列表，播放走当前输出设备。
6. 补充测试并执行 TypeScript、Vite、Python compileall、目标 pytest。

## 风险评估

- 当前 ASR 仍是“pseudo-streaming partial”，不是 RNNT 级逐 token 模型；真实首字到首包是否小于 1 秒取决于 partial ASR 推理速度、Higgs 首包速度和 GPU负载。自动化测试只能证明协议链路没有等待 final。
- speculative partial TTS 可能播出与 final 略有差异的短文本；这是低延迟和准确性的取舍。final 文本仍会显示用于校正。
- 音效播放到虚拟声卡依赖 Chromium/Electron 的 `HTMLMediaElement.setSinkId()` 和系统音频设备枚举；本仓库可验证代码路径，真实 VB 声卡需要在目标机器上选择设备后实测。
