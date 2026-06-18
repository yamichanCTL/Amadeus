# 修复实时 ASR+TTS 音频 URL 清理导致中断

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **子文档**: 暂无

## 任务目标

- 修复 `实时 ASR + TTS` 在一句话 VAD 结束并生成 TTS 后自动中断的问题。
- 保证除非用户点击停止或组件卸载，否则实时 WebSocket 一直保持连接，并持续对每一句最终识别文本执行 TTS。

## 影响范围

- `frontend/desktop/src/pages/VoiceChanger.tsx`
- `doc/CHANGELOG.md`
- `doc/desktop/TTS_VOICE.md`

## 实现步骤

1. 检查实时 TTS 页面生命周期，确认是否有非用户操作触发 `VoiceTTSStreamingClient.stop()`。
2. 将组件卸载清理与 `inputAudioUrl` / `outputAudioUrl` 变化解耦，避免每次 TTS 输出 URL 更新时关闭 WebSocket。
3. 使用 ref 保存最新音频 URL，组件卸载时统一释放当前 URL。
4. 更新变更日志和 TTS 文档。
5. 运行桌面端 TypeScript 与构建验证。

## 风险评估

- 如果只移除依赖 cleanup，可能造成当前音频 Object URL 在卸载时未释放；因此用 ref 保留最新 URL 并在卸载时释放。
- 语音转 TTS 的单句录音模式仍需要在返回 TTS 后停止麦克风，不能被实时模式修复影响。
