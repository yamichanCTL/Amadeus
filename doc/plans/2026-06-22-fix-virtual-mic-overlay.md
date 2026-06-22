# 修复虚拟麦克风的错误叠加导致 ASR 异常

> **相关计划**：[恢复异常回退的 Amadeus 桌面文件](2026-06-22-restore-amadeus-reverted-files.md)

## Context（为什么要改）

桌面前端的 `AudioRelayMixer`（音频中转混音器）在打开真实麦克风时开启了浏览器的 `echoCancellation` + `noiseSuppression` DSP。这带来两个直接后果：

1. **违反透传要求**：虚拟麦克风输出（写入 `context.destination`，即 CABLE Input）经过了 AEC/NS 处理，波形与真实麦克风不一致。
2. **污染 ASR 输入（真正的 bug）**：ASR 通过 `createInputStream()` 拿到的是同一条 DSP 处理过轨道的 clone，因此 ASR 收到的是被 AEC/NS 扭曲后的音频 —— AEC 在非扬声器场景下会误减真实语音、引入音乐噪声，正是用户看到的“ASR 识别异常”。

TTS 叠加架构本身是正确的（`microphoneGain=1` 透传 + `injectionGain=1` 叠加到 destination，`createInputStream` clone 的是进入 AudioContext 之前的原始轨道，TTS 不会泄漏进 ASR），无需改动。核心修复就是关闭 relay 上的浏览器 DSP，让虚拟输出和 ASR 都拿到干净的真实麦克风。

同时补充：防回环保护（输入若落到虚拟线缆的输出端会形成反馈）和设置页的通路调试（真实麦克风 in → 虚拟麦克风 → 默认扬声器 out）。

## 目标 / 要求对齐

- 常态：虚拟麦克风输出 = 真实麦克风输入，波形一致，纯透传。
- TTS：在虚拟输出上叠加合成语音，真实麦克风响度不变（gain 恒为 1）。
- 不影响真实输入：ASR 拿到的 clone 不含 DSP、不含 TTS。
- 设置页调试：可验证“真实麦克风 → 虚拟麦克风 → 默认扬声器”通路，带电平显示。

## 改动范围

只需编辑两个文件，其余调用方（App / Transcribe / RealtimeAgent / VoiceChanger）的公共 API 不变，自动受益于干净透传。

### 1. `frontend/desktop/src/services/audio.ts` — `AudioRelayMixer`

**a. 纯透传**（`start()` 内 getUserMedia 约束，约 305-315 行）：
- `echoCancellation: false, noiseSuppression: false, autoGainControl: false`。
- 改写注释：纯透传是因为 ASR clone 同一轨道，任何浏览器 DSP 都会同时扭曲虚拟输出与 ASR；回声/反馈由结构保证（TTS 走独立虚拟 sink + 下面的回环保护）。

**b. 回环保护**（`start()` 在 getUserMedia 成功后、建 AudioContext 前）：
- 新增并导出 `isLoopbackPair(inputLabel, outputLabel): boolean`：用 `isLikelyLoopbackInput`（已存在，613 行）匹配 monitor/stereo mix/loopback 等；再用归一化比较 `CABLE Output`(输入) 与 `CABLE Input`(输出) 这类同一线缆两端 —— 去掉 `input|output` 后缀比较前缀，前缀相同且一端 input 一端 output 即判为回环对。
- `start()` 中读取输入轨道 label 与输出设备 label（`enumerateDevices` 匹配 `outputDeviceId`），命中回环则抛出中文错误。该错误会沿现有 `toggleAudioRelay` 的 catch 进入 `routeStatus`。

**c. 电平与监听**（新增节点与方法）：
- `start()` 中新增 `micAnalyser: AnalyserNode`（fftSize=1024, smoothing=0.7），接在 `microphoneSource` 之后，不继续连接（仅作输入电平探针）。
- 新增独立的“监听上下文”用于把真实麦克风临时引到**默认扬声器**（不动虚拟 sink）：
  - 字段：`monitorContext / monitorSource / monitorGain / monitorAnalyser / monitorStream`。
  - `startMonitor(durationMs): Promise<void>`：clone 一份 `inputStream` 轨道，新建 `AudioContext`（**不**调用 setSinkId → 走系统默认扬声器），`source→gain(1)→analyser→destination`，`resume()` 后 `setTimeout(stopMonitor, durationMs)`。
  - `stopMonitor(): void`：断开并 close 监听上下文，停掉 monitorStream 轨道。
  - `getInputLevel(): number | null`：读 `micAnalyser`，复用 `AudioRecorder.startLevelMonitor` 的 `min(1, max(peak*0.7, rms*4))` 公式。
  - `getMonitorLevel(): number | null`：读 `monitorAnalyser`，同样的电平公式。
- `stop()` 开头先 `stopMonitor()`，并 disconnect `micAnalyser`。

> 设计依据：Web Audio 不支持跨 AudioContext 路由；`context.destination` 经 setSinkId 指向虚拟线缆，无法再分接到默认扬声器。要听到“真实麦克风→默认扬声器”必须用第二个 AudioContext。`AnalyserNode` 是本文件已广泛使用的零开销电平探针。

### 2. `frontend/desktop/src/pages/Settings.tsx`

在现有“常态透传”勾选项（162-165 行）之后，新增一个 `wide` 调试面板，**仅在 `audioRelayMixer.isActive()` 为真时渲染**：

- 标题：`通路测试：真实麦克风 → 虚拟麦克风 → 默认扬声器`
- 两条电平条：`输入电平`（`getInputLevel()`）、`监听电平`（`getMonitorLevel()`，仅监听期间有值）。
- 按钮 `开始监听 5 秒` → `audioRelayMixer.startMonitor(5000)`，期间 `monitoring=true`，结束后复位；错误进 `monitorError`。
- 按钮 `停止`（非监听中禁用）→ `stopMonitor()`。
- `<small>` 说明：点击后真实麦克风会从默认扬声器播出 5 秒用于验证通路；虚拟麦克风输出不受影响；确保 Windows 默认播放设备是真实扬声器而非 CABLE Input。
- 电平动画：`useEffect` 监听 `monitoring`，`requestAnimationFrame` 节流 ~70ms 刷新两条电平；非监听时以 ~200ms 低频刷新输入电平条以确认麦克风在线。

新增 state：`monitoring / inputLevel / monitorLevel / monitorError` 与一个 `rafRef`。沿用现有 `.panel` / `.wide label` 样式，电平条用内联宽度即可（调试控件）。

## 不需要改动的调用方（确认仍工作）

- `App.tsx:115-126` start/stop：`start` 入参形状不变；回环抛错已被 catch → `setError`。
- `Transcribe.tsx:306-307,462-463` 与 `RealtimeAgent.tsx:1114-1115,1144` 的 `createInputStream()`：自动拿到干净麦克风，ASR 改善。
- `RealtimeAgent.tsx:402-408` `playBlob` TTS 叠加：不变。
- `VoiceChanger.tsx` 自有 `new AudioRelayMixer()` 实例：自动获得纯透传 + 回环保护，签名不变。
- `runAudioRelayDeviceE2E`（440-454 行）：不动。

## 行为变化与风险

- **半双工更积极（可接受）**：AEC 关闭后，`VoiceTTSStreamingClient` 的 `PcmStreamer` 在 TTS 播放期间会触发半双工静音（`echoCancellationEnabled===false`）。这只影响 VoiceChanger 的实时变声流；主 `StreamingASRClient`（RealtimeAgent 免按键）不调用 `setOutputPlaybackActive`，不受影响。
- **不再有 NS 兜底**：极嘈杂环境会失去浏览器 NS，但这是“纯透传”要求的刻意取舍。
- 监听上下文额外延迟：5 秒调试听感无所谓，不做相位对齐。

## 验证方式

无前端 pytest，门槛是 TS + Vite 构建 + 实机。

1. `cd frontend/desktop && npx tsc --noEmit`（strict）。
2. `npm run build`（或 `npx tsc && npx vite build` 快验）。
3. 实机（Windows + VB-Cable + DJI Mic）：
   - 设置页选 DJI 为输入、CABLE Input 为输出，启用中转 → `routeStatus` 正常无回环错。
   - 新面板点“开始监听 5 秒” → 默认扬声器听到自己声音，两条电平条跳动，5 秒自停。
   - 转写页录音 → ASR 准确（回归症状消失）。
   - RealtimeAgent 免按键对话 → TTS 经虚拟线缆播出，TTS 期间后端不收 mic PCM，TTS 后恢复。
   - 负向：输入选“跟随系统”且 Windows 默认录音设为 CABLE Output → 启用中转必须被回环保护拒绝；改回 DJI 后可正常启动。
   - VoiceChanger：启用其中转跑一轮实时变声 → TTS 叠加正常、ASR 仍可用。
