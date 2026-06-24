# 修复公网 WebSocket 连接提示并对齐 Higgs 流式 TTS

## 任务目标

- 对比 staged 与未暂存改动，确认公网 `ws://your-server-ip:18000/v1/tts/higgs/stream` 连接失败的来源。
- 参考 `/home/yami/AI/audio/TTS/higgs-audio/webui.py`，让后端 Higgs 流式代理严格按上游 webui 的 PCM chunk 方式转发。
- 优化前端 WebSocket 连接失败处理，保留 staged 中可用路径，不把连接层问题误导成 TTS 流式能力问题。

## 影响范围分析

- `backend/app/api/v1/tts_api.py`
  - 对齐 Higgs webui 的 chunk size、PCM header 校验和 16-bit sample 对齐。
  - 在 `tts_chunk` / `tts_done` 中返回 channels、bit depth、sample rate。
- `frontend/desktop/src/services/audio.ts`
  - 优化 WebSocket URL 候选与错误提示，必要时可尝试同源 `/v1` 代理路径。
  - 保持 staged 里简洁错误，不强行写死“后端内部调用 127.0.0.1”的结论。
- `frontend/desktop/src/pages/VoiceChanger.tsx`
  - 如服务层事件字段变化，保持实时 TTS chunk 播放逻辑兼容。
- `backend/tests/test_higgs_tts_api.py`
  - 覆盖 PCM header 与 chunk 对齐。
- 文档与 CHANGELOG
  - 记录本次修复与公网 WebSocket 诊断边界。

## 实现步骤

1. 检查 staged 与 unstaged diff，确认 WebSocket 报错文案来自 staged，流式改动只影响协议事件。
2. 读取上游 `webui.py` 的 `synthesize_streaming` 和 `build_payload` 实现，按其规则修正后端 chunk 代理。
3. 前端 WebSocket 客户端增加候选 URL 机制：显式后端地址优先，开发同源代理作为候选；失败时输出实际尝试过的 URL。
4. 更新单元测试，验证 `stream=true`、`pcm`、`x-sample-rate`、`x-channels`、`x-bit-depth` 和 16-bit 对齐。
5. 更新 `doc/CHANGELOG.md` 与 `doc/desktop/TTS_VOICE.md`。
6. 执行 TypeScript、Vite、Python compileall 和目标 pytest。

## 风险评估

- 如果公网 18000 前面是 Nginx/网关且没有开启 WebSocket Upgrade，本项目只能给出明确诊断；必须修公网代理配置才能真正连通。
- 同源代理候选只在 Vite/Electron 当前 origin 能转发 `/v1` 时有效；打包后的 file/app 页面仍需要显式后端地址或主进程代理。
- 流式播放目前按 Higgs webui 的 PCM16 单声道格式实现；若上游返回其他 channels/bit depth，后端会报错而不是播放错误音频。
