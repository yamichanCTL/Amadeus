# Higgs TTS 与变声器

> **父文档**: [← 返回桌面端](README.md)
> **子文档**: 暂无

## 部署假设

Higgs v3 TTS 服务与 ASR 后端部署在同一台服务器，但使用不同端口。桌面端默认配置为：

```text
ASR 后端: http://localhost:8000
Higgs TTS: http://localhost:8002
```

桌面端后端地址支持填写完整 URL 或 `host:port`。例如公网测试可填写 `112.124.13.120:18000`，前端会规范化为 `http://112.124.13.120:18000`，WebSocket 会对应使用 `ws://112.124.13.120:18000`。

Higgs 服务按 `audio/TTS/higgs-audio/webui.py` 的调用方式兼容：

- `GET /health`
- `GET /v1/audio/voices`
- `POST /v1/audio/speech`

## 后端接口

ASRAPP 后端在 `/v1/tts/higgs/*` 下提供轻量代理：

| 接口 | 用途 |
|---|---|
| `GET /v1/tts/higgs/health?higgs_base_url=` | 检查 Higgs 服务状态 |
| `GET /v1/tts/higgs/voices?higgs_base_url=` | 获取 Higgs 音色列表，并合并后端本地保存的音色 |
| `GET /v1/tts/higgs/voice-presets` | 获取后端本地保存的 Higgs 音色 preset |
| `POST /v1/tts/higgs/voice-presets` | 保存本地音色 preset，包含音色名、参考音频、参考音频链接、准确文本和 `reference_codes` |
| `POST /v1/tts/higgs/reference-asr` | 使用当前 ASR 引擎为上传的参考音频生成准确文本初稿 |
| `POST /v1/tts/higgs/speak` | 文本直接合成 TTS |
| `POST /v1/tts/higgs/audio-to-speech` | 上传音频后 ASR，再将识别文本送入 Higgs TTS |
| `WS /v1/tts/higgs/stream` | 麦克风 PCM 流在后端完成 VAD→ASR→Higgs TTS，并返回 TTS 音频事件 |

音频响应通过 header 暴露延迟：

| Header | 含义 |
|---|---|
| `X-Timing-ASR` | ASR 环节耗时 |
| `X-Timing-TTS` | TTS 环节耗时 |
| `X-Timing-Higgs-Network` | 后端调用 Higgs 的网络/生成耗时 |
| `X-Timing-Total` | 后端总耗时 |
| `X-ASR-Text-B64` | Base64 UTF-8 编码的识别文本 |

## 前端模式

`frontend/desktop/src/pages/VoiceChanger.tsx` 提供三个模式：

- `语音转 TTS`：录音按钮走 `WS /v1/tts/higgs/stream`。后端检测到一句话结束后执行 final ASR，再调用 Higgs TTS，并将音频作为 `tts` 事件返回；上传音频则走 `/v1/tts/higgs/audio-to-speech`。
- `文字转 TTS`：输入文本后直接调用 `/v1/tts/higgs/speak`。
- `实时 ASR + TTS`：持续连接 `WS /v1/tts/higgs/stream`，每个最终识别片段都由后端触发一次 Higgs TTS。

## 模型管理

TTS 模型配置位于 `模型管理 → TTS 模型设置`，不再放在 `变声器/TTS` 工作台中。常用项直接展示在页面主体；弹窗只用于上传、检查和保存音色。该页面负责：

- 配置 Higgs API 地址。
- 检查 `/health` 并刷新 `/v1/audio/voices` 音色列表。
- 参考 Higgs webui 的音色下拉行为，支持已注册音色选择，也支持手动输入自定义音色名。
- 持久保存当前音色和刷新到的音色列表，保存在桌面端 Zustand store 的 `higgsTtsVoice` / `higgsTtsVoices`。
- 在页面主体直接选择当前音色、输出格式、句首控制标签和生成参数。
- 在弹窗中上传参考音频、播放检查参考音频、调用当前 ASR 生成参考文本、填写参考音频链接和 Code JSON，并用音色名保存为后端本地音色 preset。
- 下次打开时从后端音色库中查找已保存音色，点击 `使用` 会恢复该音色对应的参考信息。
- 配置 Zero-shot / reference voice：参考音频 Data URL、参考音频 URL、参考音频准确文本和 `reference_codes` JSON。
- 配置句首控制标签：emotion、style、prosody speed、pitch、expressiveness。

`变声器/TTS` 工作台会读取这些设置，并额外提供本次使用音色下拉，用于临时切换文本 TTS、上传音频 ASR→TTS、后端 VAD 录音和实时 ASR+TTS 请求。

后端本地音色 preset 默认写入 `data/tts/voices/<id>/`，可通过环境变量 `ASRAPP_TTS_VOICES_DIR` 改为其他路径。每个音色目录包含 `meta.json`、`reference.wav`（或其他音频后缀）、`reference.txt` 和可选 `reference_codes.json`。旧版 `data/higgs_voice_presets.json` 仍会被兼容读取。`GET /v1/tts/higgs/voices` 即使远端 Higgs 服务暂时不可用，也会返回本地保存过的音色名。调用 TTS 时如果请求没有显式携带参考音频、参考音频链接或 Code JSON，但 `voice` 命中了本地 preset，后端会自动把该 preset 的参考信息加入 Higgs payload。

`/home/yami/AI/audio/TTS/higgs-audio/webui.py` 没有独立的“音色相似度”滑杆或数值参数。音色相似度相关能力来自已注册 `voice`、`references`（参考音频 + 准确文本）和 `reference_codes`；其中 `reference_codes` 会优先于参考音频。

## 输出设备

页面通过 `navigator.mediaDevices.enumerateDevices()` 列出 `audiooutput` 设备，并在播放时调用 `HTMLMediaElement.setSinkId()`。支持的 Chromium/Electron 环境可以把音频输出到 VB 等虚拟声卡；不支持 `setSinkId` 的平台会回落到系统默认输出。

## 实时链路

`VoiceTTSStreamingClient` 的 `closed` 事件会标记是否由前端主动停止。实时 ASR+TTS 模式下：

- 用户点击停止时关闭 WebSocket 并回到 `idle`。
- 一句话 `语音转 TTS` 点击停止时只结束麦克风输入，不立即关闭 WebSocket；前端会等待后端 final ASR 和 TTS 音频返回后再关闭连接。
- 后端返回单句 `tts` 事件后继续保持 `streaming`，不会把一次 VAD 结束当作整条实时流结束。
- 非主动断开才进入错误状态，避免一句话播放后误判异常中断。
- TTS 音频返回后会更新输出音频 URL，但 URL 清理不会触发 `VoiceTTSStreamingClient.stop()`；实时连接只在用户停止或组件卸载时关闭。
- 前端使用较小的 PCM 处理块并以二进制 WebSocket 帧发送 PCM，减少 JSON/Base64 编码开销。

## 延迟显示

页面展示：

- ASR
- TTS
- Higgs 网络
- 后端总计
- 前端端到端

实时模式和一句话录音模式使用后端 `tts` 事件中的 timing；上传音频模式使用 HTTP 响应 header 中的 ASR/TTS 耗时；文本模式 ASR 显示为无需 ASR。

## 验证

可重复验证命令：

```bash
.venv/bin/python -u scripts/verify_higgs_tts_e2e.py
.venv/bin/python -m pytest backend/tests/test_higgs_tts_api.py backend/tests/test_streaming_session.py -q
cd frontend/desktop && node node_modules/typescript/bin/tsc --noEmit
cd frontend/desktop && node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit
cd frontend/desktop && node node_modules/vite/bin/vite.js build
```

`scripts/verify_higgs_tts_e2e.py` 使用 mock ASR 和假 Higgs 服务验证：

- Higgs health/voices 配置通路。
- 文本 TTS 通路。
- 上传音频 ASR→TTS 通路。
- 后端 final ASR→TTS WebSocket 事件 payload。
- ASR、TTS、Higgs 网络和总耗时字段。

音频输出设备选择依赖 Electron/Chromium 的 `HTMLMediaElement.setSinkId()` 和操作系统音频设备枚举。本仓库无 GUI 验证环境时，可通过 TypeScript/Vite 构建验证代码路径；真实输出到 VB 等虚拟声卡需要在 Windows/Electron 运行环境选择设备后播放确认。
