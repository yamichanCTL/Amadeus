# 远程 Higgs TTS 与开发调试台

> **父文档**: [← 返回桌面端总览](README.md)
> **相关文档**: [语音识别](SPEECH_RECOGNITION.md) · [Higgs TTS 与变声器](TTS_VOICE.md)

## Higgs TTS 来源

模型管理的 TTS 设置可选择：

- `本地部署`：调用配置的本地 Higgs `/v1/audio/speech` 服务。
- `Boson 远程 API`：由 ASRAPP 后端代理调用 Boson；桌面端配置 API 地址、`higgs-audio-v3-tts` 模型和 Token。

Boson Token 只放在后端到远端的 `Authorization: Bearer ...` 请求头中，不写入合成 payload、响应或业务日志。远程流式模式固定请求 `response_format=pcm`、`stream=true`，按 24 kHz、16-bit、单声道 PCM 播放。

## 开发调试台

侧栏“开发调试台”维护最多 500 条内存事件，页面刷新后清空，不写入持久存储。除原始事件表外，最近 12 个任务按 trace 聚合成阶段瀑布图。当前统计：

- HTTP 端到端和 `X-Process-Time` 后端耗时；
- ASR WebSocket 建连；
- VAD 开始到首个 partial、最终 final；
- 文件 ASR 的确认、上传、模型、ASR、标点、热词、LLM、持久化和前端展示；
- 实时变声的 VAD、ASR 首 token/final、TTS 请求、首个可播放音频 token/chunk 和完成时间；
- 状态码、错误与安全的请求路径（不记录 body 或 Token）。

可按类别筛选、清空或导出 JSON。

Higgs 当前流式协议不单独暴露内部声学 token；调试台中的“TTS 首 token / 首音频”严格指后端收到的第一个可播放 PCM token/chunk，也是用户可感知首包延时边界。

---

> 📖 [返回桌面端总览 →](README.md)
