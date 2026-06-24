# 修复变声器「播放到输出设备」音频无法路由到虚拟麦克风

## 目标

变声器 TTS 页面「播放到输出设备」按钮点击后，TTS 音频无法输出到用户选择的虚拟麦克风设备（如 VB-Cable）。

## 根因分析

`playAudioBlob` 使用 `HTMLAudioElement` + `HTMLAudioElement.setSinkId()` 做设备路由：

```ts
const audio = new Audio(url)
audio.setSinkId(outputDeviceId)
audio.play()
```

`HTMLAudioElement.setSinkId` 是 Chromium 实验性 API，对虚拟音频设备（VB-Cable 等）支持不可靠。

项目中已存在可验证的设备路由方案——`Pcm16ChunkPlayer` 和 `AudioRelayMixer` 都使用 `AudioContext.setSinkId`，该 API 在 Electron 31（Chromium 126）中已正式支持且对虚拟设备兼容良好。

另外，`playResult()` 无参调用时通过 `fetch(blobUrl)` 取回 Blob，`await` 跨越异步边界导致 user gesture 丢失，也有隐患。

## 修改内容

### 1. `playAudioBlob` — 从 HTMLAudioElement 改为 Web Audio API

- 创建 `AudioContext` → `setSinkId` → `decodeAudioData` → `AudioBufferSourceNode` → `connect(destination)` → `start()`
- 返回 `{ stop, sinkApplied, sampleRate }` 替代旧的 `{ audio, url, sinkApplied }`
- 播放结束自动 `context.close()`
- `setSinkId` 失败降级到系统默认设备

### 2. `playResult` — 适配新返回类型 + 错误处理

- 新增 `outputBlobRef` 保存原始 Blob，优先使用避免 fetch
- `playbackRef.current.stop()` 替代 `playbackRef.current?.pause()`
- 移除 `playbackUrlRef`（Web Audio API 没有 blob URL）
- 添加 try-catch 展示错误

### 3. 清理函数适配

- `playbackRef.current?.stop()` 替代 `.pause()`
- 移除 `playbackUrlRef` 清理

## 影响范围

- `frontend/desktop/src/services/audio.ts` — `playAudioBlob` 重构
- `frontend/desktop/src/pages/VoiceChanger.tsx` — 调用方适配

## 验证

- TypeScript 编译零错误
- 实际设备路由需在桌面端运行时验证（`AudioContext.setSinkId` 在 Electron 31 中可用）
