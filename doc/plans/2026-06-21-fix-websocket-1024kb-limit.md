# Fix "Part exceeded maximum size of 1024KB" in voice-to-TTS flow

## 目标

修复语音转 TTS 前端报错 `Part exceeded maximum size of 1024KB`。

## 根因分析

经过排查，该错误涉及**两个不同代码路径**，分别有各自的限制：

### 1. WebSocket 流式 TTS 完整合并音频（第一轮修复）

`_send_stream_tts_events()` 在逐 chunk 发送 `tts_chunk` 事件后，又发送了一个包含**全部合成音频 base64** 的 `tts` 事件。Python `websockets` 库默认 `max_size=2**20`（1024KB），长语音（>16秒 @ 24000Hz PCM16）的完整音频 base64 编码后超过此限制。

**修复**: 移除该冗余 `tts` 事件，因为音频已通过 `tts_chunk` 逐 chunk 送达，`tts_done` 已发送完成信号。

### 2. Starlette multipart 单字段大小限制（第二轮修复 — 真正触发用户报错的原因）

Starlette 的 `MultiPartParser.max_part_size` **默认值为 1024KB (1MB)**。当用户使用"录音"模式录制音频并通过 multipart/form-data POST 到 `/v1/tts/higgs/audio-to-speech` 时，录制的音频文件（WebM/Opus 格式）很容易超过 1MB（5 秒录音即可超过）。

Starlette 源码（`formparsers.py:184-185`）：
```python
if len(self._current_part.data) + len(message_bytes) > self.max_part_size:
    raise MultiPartException(f"Part exceeded maximum size of {int(self.max_part_size / 1024)}KB.")
```

报错文本完全匹配用户看到的 `Part exceeded maximum size of 1024KB`。

**修复**: 在 `create_app()` 中设置 `MultiPartParser.max_part_size = settings.max_upload_size_bytes`（默认 500MB），与应用的 `max_upload_size_mb` 保持一致。

## 影响范围

- `backend/app/main.py` — `create_app()` 函数，新增 multipart max_part_size 配置
- `backend/app/api/v1/tts_api.py` — `_send_stream_tts_events()` 函数，移除冗余 `tts` 事件

## 风险

低。两个修改都是提升/放宽限制，不改变业务逻辑：
- WebSocket: 移除的消息是冗余的，音频已通过 chunk 送达
- Multipart: 仅提高限制以匹配已有的 `max_upload_size_mb` 配置
