# 桌面端 TTS 模型设置与实时链路修复

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **子文档**: 暂无

## 任务目标

- 在桌面前端 `模型管理` 中新增 `TTS 模型设置`，集中配置 Higgs TTS API 地址、音色和生成参数。
- 从 `变声器 / TTS` 工作台移除模型地址和音色配置入口，仅消费模型管理中永久保存的 TTS 设置。
- 参考 `~/AI/audio/TTS/higgs-audio/webui.py` 的音色列表行为，支持刷新 Higgs 音色列表并持久保存选中的音色。
- 修复 `实时 ASR + TTS` 中一句话 VAD 结束并返回 TTS 后前端异常中断的问题，让连接保持持续实时。

## 影响范围

- `frontend/desktop/src/pages/Models.tsx`
- `frontend/desktop/src/pages/VoiceChanger.tsx`
- `frontend/desktop/src/services/audio.ts`
- `frontend/desktop/src/store/useASRStore.ts`
- `frontend/desktop/src/styles/global.css`
- `doc/CHANGELOG.md`
- `doc/desktop/README.md`
- `doc/desktop/TTS_VOICE.md`

## 实现步骤

1. 在 `Models.tsx` 增加 `tts` tab，读取/保存 `higgsTts*` 设置，并通过 `/v1/tts/higgs/health` 与 `/v1/tts/higgs/voices` 检查服务和刷新音色。
2. 在 `VoiceChanger.tsx` 删除 Higgs 地址、音色与生成参数表单，保留服务状态、输出设备和操作区；所有 TTS 请求继续使用 store 中的设置。
3. 调整 `VoiceTTSStreamingClient`，为主动停止增加状态标记，避免手动关闭和异常关闭混淆。
4. 修复实时模式收到 `tts` 后的状态处理，确保不会把一句话 TTS 播放当作整条实时流结束。
5. 更新桌面端 TTS 文档和变更日志。
6. 运行 TypeScript / 构建 / 后端 TTS 单测进行验证。

## 风险评估

- 浏览器自动播放策略可能影响 TTS 音频播放，但不应再关闭实时 WebSocket；播放失败需要以错误状态提示。
- 音色列表依赖 Higgs 服务在线，离线时保留本地已保存音色并提供手动输入能力。
- 当前工作区已有大量未提交改动，本次只修改相关桌面端和文档文件，不回退已有变更。
