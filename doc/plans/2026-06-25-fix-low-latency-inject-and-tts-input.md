# 修复低延迟输入与 TTS 收音

> **父文档**: [← 返回计划索引](README.md)
> **子文档**: 无

## 任务目标

- ASR 最终结果返回后立刻尝试输入，避免等待归档/历史写入和每次冷启动 PowerShell。
- 降低光标在输入框内但偶发粘贴失败的概率，失败时仍保留剪贴板与结果浮窗。
- 修复实时 ASR+TTS/变声器输入卡顿，减少主线程音频回调和 WebSocket 堆包造成的收音断续。

## 影响范围

- `frontend/desktop/electron/main.ts`：文本注入 helper 生命周期、低延迟粘贴。
- `frontend/desktop/src/services/recordingService.ts`：先注入再归档，归档后台化。
- `frontend/desktop/src/services/audio.ts`：PCM 采集、WebSocket 发送背压、TTS 流生命周期。
- `frontend/desktop/src/pages/VoiceChanger.tsx`：录音复用预热流，实时播放/收音状态。
- `doc/desktop/TTS_VOICE.md`、`doc/CHANGELOG.md`：同步行为说明与变更记录。

## 实现步骤

1. 将 Windows 文本注入改为常驻 PowerShell STA helper，加载 UIAutomation 与 SendInput 代码一次，后续请求走 stdin/stdout。
2. 在离线 ASR 完成后立即更新 UI 并触发注入；归档音频/JSON 和历史补充在后台继续执行。
3. 为 PCM 流增加 AudioWorklet 优先路径，ScriptProcessor 仅作兜底；发送前检查 `WebSocket.bufferedAmount`，丢弃过期音频帧而不是阻塞。
4. 变声器录音开始时复用 `AudioRecorder.prepare()` 的已预热流，去掉开始时额外 350ms 等待。
5. 增加聚焦的测试/构建验证，并更新 CHANGELOG 与桌面 TTS 文档。

## 风险评估

- Windows 注入 helper 需要在非 Windows 环境保持 TypeScript 编译通过；运行时只在 Windows 启用。
- AudioWorklet 在部分 Electron/Chromium 环境可能不可用，必须保留 ScriptProcessor 兜底。
- 先注入再归档会让历史条目在短时间内缺少归档路径，后台成功后需要补齐同一条历史记录。
