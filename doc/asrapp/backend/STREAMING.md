# Backend 原生流式识别

> **父文档**: [← 返回 Backend 总览](README.md)
> **子文档**: [X-ASR 流式设计](../asr/STREAMING.md)

Backend 的 `WS /v1/stream` 只接受支持 `create_streaming_session()` 的原生流式模型。目前为可切换 160 / 480 / 960 / 1920 ms 窗口的 X-ASR Zipformer，不再支持离线模型分块重跑或 final 离线精修。

## 客户端配置

```json
{"type":"config","engine":"x-asr","language":"zh","archive":true}
```

音频可发送二进制 `pcm_s16le` 帧，也可发送 base64 JSON。桌面端固定采集 16 kHz、单声道、512 samples/帧。

## 流程

```text
PCM → VAD speech_start → 回灌 700 ms pre-roll → 创建 X-ASR online stream
    → 每帧 accept/decode → partial
    → VAD speech_end → 补 1000 ms 静音 → input_finished → final
```

关键点：

- VAD 下降沿决定话语结束，不使用 VAD 内部音频队列替代原始 PCM。
- partial 和 final 来自同一 online decoder state。
- 不支持流式的 engine 会被明确拒绝，不回退离线识别。
- 会话最长 10 秒强制切句，完整接收音频可按配置归档。

服务端事件包括 `ready`、`configured`、`speech_start`、`partial`、`final`、`no_speech`、`archive`、`error` 和 `done`。

可选的 `config.agent.enabled=true` 会将非空 final 按顺序送入 Codex，并在同一连接返回
`agent.queued`、`agent.started`、`agent.delta`、`agent.completed` 等事件；开启后 `done` 等待 Agent 队列完成。
模型选择、取消和用量字段见 [ASR → Codex Agent](CODEX.md)。

## 模型失败与连接终止

客户端发送 `config` 后，后端会先返回 `loading`，并预热 VAD 与 X-ASR。CUDA 模式下 X-ASR 必须完成一次真实静音 decode，之后才会被模型管理器标记为已加载。因此 recognizer 虽已创建、但 cuDNN 版本不兼容或显存不足的情况不会再显示为 ready。

致命模型错误只使用以下两个公开错误码：

| code | message 前缀 | 含义 |
|------|----------------|------|
| `model_not_loaded` | `模型没有加载` | 模型文件、CUDA/cuDNN 运行库或 native 推理初始化不可用 |
| `gpu_out_of_memory` | `显存不足` | CUDA、cuDNN、cuBLAS 或 ONNX Runtime 无法分配所需 GPU 内存 |

```json
{
  "type": "error",
  "code": "model_not_loaded",
  "message": "模型没有加载：x-asr CUDA/cuDNN 运行库版本不兼容。",
  "model": "x-asr",
  "fatal": true,
  "session_id": "..."
}
```

错误事件发送完成后，服务端使用 WebSocket close code `1011` 主动关闭连接。失败会话走 abort 路径，不再调用已经报错的 decoder `finish()`；下一次明确加载或新会话会重新执行 load 与 warm-up。

> 📖 [完整 X-ASR 流式设计 →](../asr/STREAMING.md)


## 手动结束的连续识别

原有「实时对话」的 Codex 模式现在发送 `endpointing: "manual"`：

```json
{"type":"config","engine":"x-asr","endpointing":"manual","agent":{"enabled":true,"session_id":"conversation-1"}}
```

该模式不加载、不运行 VAD；使用同一个 X-ASR online decoder 持续接收 PCM 并返回 partial。静音、长停顿和原 VAD 模式的 `stream_max_segment_ms` 都不会触发 final。仅收到客户端 `end` 后补尾部静音、结束 decoder，产生一次完整 final 并交给 Codex。断开连接时丢弃未提交录音，避免导航或网络断开意外发起 Agent 请求。

没有 `endpointing` 参数的其他客户端保留 `vad` 模式兼容行为；这不是「实时对话」的处理路径。AEC 与 VAD 相互独立：AEC 消除输入中的播放回声，manual 控制何时提交识别结果。
