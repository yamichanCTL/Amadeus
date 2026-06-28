# Higgs TTS 与变声器

> **父文档**: [← 返回桌面端](README.md)
> **子文档**: 暂无

## 部署假设

Higgs v3 TTS 服务与 ASR 后端部署在同一台服务器，但使用不同端口。桌面端默认配置为：

```text
ASR 后端: http://localhost:8000
Higgs TTS: http://localhost:8002
```

桌面端后端地址支持填写完整 URL 或 `host:port`。例如公网测试可填写 `your-server-ip:18000`，前端会规范化为 `http://your-server-ip:18000`，WebSocket 会对应使用 `ws://your-server-ip:18000`。

开发模式下后端地址为空时，浏览器会通过 Vite 同源代理访问 `/v1/*`；Electron 打包或 `file:` / `app:` 页面下没有 Vite 代理，空后端地址会回落到 `http://localhost:8000`。公网 IP 前端来源也会被后端 CORS 放行，避免参考音频 ASR 这类跨端口请求被浏览器拦截成 `Failed to fetch`。

如果浏览器提示 `WebSocket 连接失败`，先区分三类情况：

- `curl http://your-server-ip:18000/v1/health` 不通：后端进程、端口或安全组未开放。
- HTTP 通但 WebSocket 不通：公网反向代理需要转发 `Upgrade` / `Connection` 头。
- 命令行 WebSocket 能收到 `ready`，但浏览器失败：检查前端是否是 HTTPS 页面连接 `ws://` 明文地址、是否运行了旧缓存构建，或是否被浏览器/系统代理拦截。

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
| `POST /v1/tts/higgs/reference-asr` | 后端保留的参考音频 ASR 辅助接口 |
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

- `语音转 TTS`：录音按钮先在前端录完整音频，停止后先调用 `/v1/tts/higgs/reference-asr`。ASR 响应到达后立即把文本填入识别结果和文字 TTS 输入状态，再调用 `/v1/tts/higgs/speak`；无需等待 TTS 音频生成完成才看到识别文本。
- `文字转 TTS`：输入文本后直接调用 `/v1/tts/higgs/speak`。
- `实时 ASR + TTS`：持续连接 `WS /v1/tts/higgs/stream`。优先在稳定自然边界提前合成；无标点中文达到 8 个稳定字并保留 1 字 look-ahead 后，也可以按 jieba 词边界提前进入 Higgs。

## 模型管理

TTS 模型配置位于 `模型管理 → TTS 模型设置`，不再放在 `变声器/TTS` 工作台中。常用项直接展示在页面主体；弹窗只用于上传、检查和保存音色。该页面负责：

- 配置 Higgs API 地址。
- 检查 `/health` 并刷新 `/v1/audio/voices` 音色列表。
- 参考 Higgs webui 的音色下拉行为，支持已注册音色选择，也支持手动输入自定义音色名。
- 持久保存当前音色和刷新到的音色列表，保存在桌面端 Zustand store 的 `higgsTtsVoice` / `higgsTtsVoices`。
- 在页面主体直接选择当前音色、输出格式、句首控制标签和生成参数。
- 在弹窗中上传或录制参考音频、播放检查参考音频、调用通用 `/v1/transcribe` 接口生成并填充参考文本、填写参考音频链接和 Code JSON，并用音色名保存为后端本地音色 preset。
- 下次打开时从后端音色库中查找已保存音色，点击 `使用` 会恢复该音色对应的参考信息。
- 配置 Zero-shot / reference voice：参考音频 Data URL、参考音频 URL、参考音频准确文本和 `reference_codes` JSON。
- 配置句首控制标签：emotion、style、prosody speed、pitch、expressiveness。

`变声器/TTS` 工作台会读取这些设置，并额外提供本次使用音色下拉，用于临时切换文本 TTS、录音/上传音频 ASR→TTS 和实时 ASR+TTS 请求。进入页面或点击检查时会同步后端已保存音色并拉取音色预设详情，避免必须先打开模型管理页才能选择新音色。

`语音转 TTS` 的录音与桌面语音识别共用稳定录音器：空闲时预热真实麦克风，开始后优先采集连续 PCM 并封装为 WAV，停止时立刻把状态浮窗切到 `thinking`。录音和实时 ASR 始终独立打开设置中选定的输入设备，即使 relay 正在输出，也不会克隆 relay 轨道或读取输出混音总线。`CABLE Output`、monitor、stereo mix、loopback 等回环/虚拟输出输入会被拒绝，避免 TTS、音效或系统输出混回 ASR。麦克风启动或停止超时会清理轨道并隐藏浮窗，不会停留在“语音输入中”。

在 `变声器/TTS` 页面内切换”本次使用音色”会立即写入全局 `higgsTtsVoice`，同时自动查找已保存的音色预设并应用其参考音频、参考音频链接、准确文本和 Code JSON。下拉框下方会显示当前音色的参考来源（已保存音频 / 参考链接 / Code JSON / 后端自动匹配）。选择 `default` 或未保存的音色名时会清空引用字段，交由后端根据音色名自动匹配。后续文本 TTS、语音转 TTS 和实时 ASR+TTS 都会使用该音色及其关联的参考信息，不需要再回到模型管理页操作。

后端本地音色 preset 统一写入 `data/tts/voices/<id>/`，可通过环境变量 `ASRAPP_TTS_VOICES_DIR` 改为其他路径。每个音色目录包含 `meta.json`、`reference.wav`（或其他音频后缀）、`reference.txt` 和可选 `reference_codes.json`。旧版 `data/higgs_voice_presets.json` 只作为迁移来源：后端读取时会把其中尚未目录化的音色写入 `data/tts/voices/<id>/`，随后将旧 JSON 清空为 `[]`，接口对外只以目录内容为准。`GET /v1/tts/higgs/voices` 即使远端 Higgs 服务暂时不可用，也会返回本地保存过的音色名。调用 TTS 时如果请求没有显式携带参考音频、参考音频链接或 Code JSON，但 `voice` 命中了本地 preset，后端会自动把该 preset 的参考信息加入 Higgs payload。

`/home/yami/AI/audio/TTS/higgs-audio/webui.py` 没有独立的“音色相似度”滑杆或数值参数。音色相似度相关能力来自已注册 `voice`、`references`（参考音频 + 准确文本）和 `reference_codes`；其中 `reference_codes` 会优先于参考音频。

## 输出设备

页面通过 `navigator.mediaDevices.enumerateDevices()` 列出 `audiooutput` 设备。未启用中转时，独立播放使用 `HTMLMediaElement.setSinkId()`；启用中转后，统一通过 `AudioContext.setSinkId()` 把整个混音总线送往 VB、BlackHole 等虚拟声卡。选择了指定设备但当前 Electron/Chromium 不支持 `AudioContext.setSinkId()` 时，中转会明确报错，不会静默把麦克风送到错误设备。

“测试输出”会在当前 sink 播放 450 ms、低音量 660 Hz 测试音；“设置 → 麦克风 → 测试输入”会采集约 1.2 秒并显示峰值、采样率和浏览器报告的 AEC 状态。默认输入保持 `跟随系统`，只有用户明确选择设备时才固定 device id。

## 麦克风音频中转

设置页和 `变声器/TTS` 页面共用应用级单例“麦克风音频中转”，负责组合实时人声和随时注入的音频。启用状态持久化，离开 TTS 页面后不会停止：

1. 用户点击“启用中转”后，`AudioRelayMixer` 只打开一次真实麦克风，并请求浏览器 AEC、降噪和关闭自动增益，再把处理后人声常态连接到当前输出 destination。
2. 实时 ASR、一句话离线录音和 `语音转 TTS` 不消费中转器的任何轨道，而是独立采集所选实体麦克风；中转器只负责向目标输出设备透传人声并叠加 TTS/音效。
3. 音效和普通 TTS 由 Web Audio 解码后连接到 injection gain；Higgs 流式 PCM16 chunk 在同一个 `AudioContext` 中排队，三类声音最终进入同一输出设备。
4. Agent 的服务端、GPT-SoVITS 和 VoxCPM2 音频也复用该总线；浏览器内置 `speechSynthesis` 无法取得 PCM，只有系统默认输出本身指向虚拟声卡时才能进入 Cable。
5. 停止中转或退出应用会停止原始麦克风、注入音源和 AudioContext；普通页面卸载不会中断常态透传。

VB-Audio Virtual Cable 的端点名称容易混淆：Amadeus 的“虚拟麦克风输出”应选择播放端点 `CABLE Input`，Windows 默认麦克风应选择录音端点 `CABLE Output`。常态下 DJI Mic Mini 等设置内真实麦克风会透传到 Cable；TTS/音效播放时叠加到同一 destination。

浏览器必须通过用户操作获取麦克风权限，因此页面不会在加载时自动接管麦克风。中转启用后的常态行为是“真实麦克风持续透传，TTS/音效按需叠加”。实体扬声器容易形成反馈回路，实际使用应选择虚拟声卡或耳机；`monitor`、`stereo mix`、`loopback` 等输出监控源会被实时 ASR+TTS 明确拒绝。

## 实时链路

`VoiceTTSStreamingClient` 的 `closed` 事件会标记是否由前端主动停止。实时 ASR+TTS 模式下：

- 用户点击停止时关闭 WebSocket 并回到 `idle`。
- 一句话 `语音转 TTS` 不再依赖 WebSocket VAD final 事件；停止录音后走完整音频上传接口，减少公网地址和 VAD 时序导致的不可用情况。
- 配置阶段会并行预热 FireRed VAD、模型管理中选择的 X-ASR 流式模型和当前 Higgs 音色；前端收到 `configured` 后才打开麦克风，冷加载不会吞掉用户开头几秒语音。
- 后端不会再把首个 unstable partial 或单字直接送入 TTS。partial 必须来自连续两次 hypothesis 的 `stable_text`；首段至少 6 个有效字符、后续至少 8 个有效字符，并优先在句号、问号、感叹号、分号、逗号等自然边界提交。没有标点时，稳定文本达到 9 字后保留最后 1 字 look-ahead，并在不超过第 8 字的 jieba 词边界提交；更短的句子仍等待 final。
- 已提交前缀必须是 final 的完整前缀；如果 final 修正了已播内容，后端不会再按字符数量切出一个错误后缀继续播报。该策略以语义正确为优先，避免上一版出现 `你 / 好， / 世界` 的碎片化输出。
- 实时请求会向 Higgs 发送 `stream=true`、`response_format=pcm` 和模型管理中的 `initial_codec_chunk_frames`（默认 `1`），并按顺序返回 `tts_start`、多个 `tts_chunk`、`tts_done`。不再重复发送包含全部音频的巨大 `tts` WebSocket 消息。
- 后端不再用 32768 字节应用层缓冲聚合首包。Higgs 原始 PCM 会先按 20 ms block 做在线边界静音门控：丢弃请求前导静音，内部自然停顿最多保留 160 ms，段尾保留 40 ms；有效语音后的连续静音达到 900 ms 时提前关闭当前 Higgs 流，避免无声尾巴阻塞下一段。随后立即转发给前端，WebAudio 连续调度多个 TTS job，新 job 不会清空上一段播放队列。
- FireRed VAD 使用 80 ms 能量 onset 提前打开流式 ASR，FireRed 继续参与端点判断；VAD 和 X-ASR CUDA decode 都移出 WebSocket 事件循环，partial 不会被后续音频帧阻塞到整句结束才发送。
- 后端返回单句 `tts_done` / `tts` 事件后继续保持 `streaming`，不会把一次 VAD 结束当作整条实时流结束。
- 前端采集轨道优先使用浏览器 AEC；如果运行时明确报告 AEC 不可用，则仅在 TTS 实际播放期间暂停上行 PCM，并在 WebAudio 播放队列清空后延迟 350 ms 恢复。AEC 可用时保持全双工，不会因为提前 TTS 截断仍在说话的用户。
- 前端 PCM 采集优先走 `AudioWorklet`，将 Float32→PCM16 转换移出 UI 主线程；不支持 AudioWorklet 的环境才回退到 `ScriptProcessorNode`。
- 后端按来源 job 保存最近 8 秒的已提交 TTS 文本。新的 ASR job 若再次识别到相同或明显包含的文本，会返回 `echo_suppressed` 并跳过 TTS；同一个原始 job 的 final 补段不会被误判为回声。
- 非主动断开才进入错误状态，避免一句话播放后误判异常中断。
- TTS 音频返回后会更新输出音频 URL，但 URL 清理不会触发 `VoiceTTSStreamingClient.stop()`；实时连接只在用户停止或组件卸载时关闭。
- 前端以二进制 WebSocket 帧发送 PCM，减少 JSON/Base64 编码开销；当浏览器待发送音频超过 64KB 时丢弃旧输入帧，避免网络或播放卡顿把 ASR 输入拖成越来越晚的延迟队列。

实时 TTS 事件字段：

| 事件 | 关键字段 | 用途 |
|---|---|---|
| `tts_start` | `text`, `job_id`, `segment_index`, `timing.asr_sec` | 后端开始为当前增量文本启动 Higgs TTS |
| `tts_chunk` | `audio_b64`, `seq`, `segment_index`, `sample_rate`, `timing.tts_first_chunk_sec`, `timing.e2e_first_audio_sec` | 前端边收边播，并显示端到端首包延迟 |
| `tts_done` | `chunks`, `audio_bytes`, `segment_index`, `trimmed_silence_ms`, `tail_silence_aborted`, `timing.tts_sec`, `timing.total_sec` | 当前 TTS 流结束，记录总耗时、边界静音和尾静音提前关闭状态 |
| `echo_suppressed` | `text`, `matched_tts_text`, `window_sec` | 新 ASR job 命中近期 TTS 输出，阻止循环合成 |

`tts_start` / `tts_chunk` / `tts_done` 会带 `source_event` 和 `speculative` 字段：`source_event=partial` 只表示已通过稳定短语规则的提前 TTS，`source_event=final` 表示整句或剩余完整后缀。

## 延迟显示

页面展示：

- ASR
- TTS 首包
- 端到端首包
- TTS 完成
- Higgs 网络
- 后端总计
- 前端端到端

实时模式使用 `tts_chunk` / `tts_done` 中的 timing，并用 `端到端首包 <= 1.000s` 作为低延迟目标的直接观测指标。一句话录音模式使用后端 `tts` 事件中的 timing；上传音频模式使用 HTTP 响应 header 中的 ASR/TTS 耗时；文本模式 ASR 显示为无需 ASR。

如果 Higgs 服务虽然接受 `stream=true` 但内部仍缓冲整段音频，页面会如实显示较高的 `TTS 首包` 和 `端到端首包`，这表示瓶颈在 Higgs 首包产出，而不是前端等待完整音频。

本次用 9.42 秒 Elysia 中文参考音频实测：首个 TTS 从 `final` 改为稳定 `partial`，语音 onset 到 TTS start 从 `3.988s` 降为 `2.933s`，到首个有效 PCM 从 `4.905s` 降为 `3.864s`；首段为完整词边界 `我还有好多好多话`，全部片段拼接仍与 4 个 VAD job 的 ASR final 完全一致，没有单字片段。短于提前提交阈值的句子仍等待 final，低延迟建议继续使用 `chunk-160ms-model`。

## 音效即时播放

`变声器/TTS` 页面提供“音效”区：

- 点击 `导入音效` 可选择多个本地音频文件。
- 每个音效会显示为一个即时播放按钮。
- 中转未启用时，播放使用当前“语音输出设备”；中转启用时，音效注入麦克风、TTS 共用的混音总线，因此选择 VB 等虚拟声卡后，人声和音效会同时输出到对应设备。
- 音效列表保存在当前页面会话中；刷新页面后需要重新导入。

## 验证

可重复验证命令：

```bash
.venv/bin/python scripts/stress_asr_reference_latency.py /path/to/test.wav --runs 10 --budget-ms 500
./scripts/test_asr_fill_mic_isolation.sh
.venv/bin/python -u scripts/verify_higgs_tts_e2e.py
.venv/bin/python scripts/benchmark_realtime_asr_tts.py backend/app/core/asr/engines/FireRedASR2S/assets/hello_zh.wav
bash scripts/test_audio_devices.sh
.venv/bin/python -m pytest backend/tests/test_higgs_tts_api.py backend/tests/test_streaming_session.py -q
cd frontend/desktop && node node_modules/typescript/bin/tsc --noEmit
cd frontend/desktop && node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit
cd frontend/desktop && node node_modules/vite/bin/vite.js build
powershell.exe -ExecutionPolicy Bypass -File ../../scripts/run_amadeus_windows_e2e.ps1
```

`test_asr_fill_mic_isolation.sh` 包含真实 React 交互边界：模拟 220 ms ASR 响应后，从停止录音到 DOM 显示文本必须小于 500 ms；另做 30 轮连续回填压力测试，并验证 relay 开启时离线 ASR、语音转 TTS 和实时 ASR 均不读取 relay 输入流。`stress_asr_reference_latency.py` 用真实音频压测已启动后端的 warm-path HTTP p95。

`scripts/verify_higgs_tts_e2e.py` 使用 mock ASR 和假 Higgs 服务验证：

- Higgs health/voices 配置通路。
- 文本 TTS 通路。
- 上传音频 ASR→TTS 通路。
- 后端 final ASR→TTS WebSocket 事件 payload。
- 实时 TTS `stream=true`、`tts_chunk` 和 `tts_done` 事件。
- unstable/单字 partial 不触发 TTS；稳定自然短语或保留 look-ahead 的词边界可以提前合成，final 追加完整剩余文本。
- TTS 片段拼接文本必须等于 ASR final，且 PCM 边界静音受限。
- ASR、TTS、Higgs 网络和总耗时字段。

音频输出设备选择依赖 Electron/Chromium 的 `HTMLMediaElement.setSinkId()` / `AudioContext.setSinkId()` 和操作系统音频设备枚举。WSL2 可用 `scripts/test_audio_devices.sh` 验证 WSLg Pulse 默认 source/sink、短录音、短播放和播放时输入隔离；Windows 物理设备及 VB/BlackHole 等虚拟声卡仍需在 Electron 页面点击“测试输入 / 测试输出”逐项确认。
