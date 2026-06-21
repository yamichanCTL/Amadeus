# X-ASR 原生流式设计

> **父文档**: [← 返回 ASR 总览](README.md)
> **子文档**: [X-ASR 接入与运行](X_ASR.md)

## 单一实时通路

实时字幕、免按键 Agent 和实时 ASR+TTS 统一走：

```text
Mic 16 kHz PCM（512 samples）
  → FireRedVAD；不可用时 Energy VAD
  → speech_start 创建 X-ASR online stream 并回灌 700 ms pre-roll
  → 新 PCM 持续 accept_waveform / decode_stream
  → 文本变化即发送 partial
  → speech_end 补 1 秒静音并 input_finished
  → 同一 stream 输出 final
```

不存在以下兼容路径：

- 周期性把当前整句话封装成 WAV 调用离线 ASR；
- 用 FireRedASR2、SenseVoice、Qwen3-ASR 或 Whisper 二次覆盖 final；
- 前端 MediaRecorder 定时切片后调用 `/v1/transcribe`。

## Buffer

| Buffer | 大小 | 作用 |
|---|---:|---|
| Ring | 3 秒 | 保存持续输入并提供 700 ms pre-roll |
| Utterance | 可变，最长 10 秒 | 归档和话语时长统计，不参与重复离线推理 |
| X-ASR state | 每句话独立 | 保存 encoder/decoder/transducer 增量状态 |

## 状态和事件

```text
IDLE → SPEAKING → FINALIZING → IDLE
```

partial 带 `true_streaming=true`。final 带同一 `engine=x-asr`，没有 `partial_engine` 或 `final_engine` 字段。

## WebSocket 握手与连接回退

`WS /v1/stream` 在 `accept()` 后立即让出一次事件循环，再在线程中构造 `StreamingASRSession`。这一步会触发 FireRed VAD 首次模型加载；如果直接在 ASGI 事件循环同步执行，握手数据无法及时刷新，浏览器会在 5 秒后主动关闭。session 初始化完成后再发送 `ready`，客户端可以在握手完成后等待该事件。

桌面客户端的候选顺序为：

1. 设置中的显式后端地址，例如 `ws://112.124.13.120:18000/v1/stream`；
2. 当前 HTTP/HTTPS 页面同源的 `/v1/stream`，开发环境由 Vite `ws: true` 代理到 8000。

候选连接只在握手前失败时切换；已经连接后的协议错误不会静默换服务器。错误消息会列出全部尝试地址，便于区分后端无响应、反向代理未转发 Upgrade 和 HTTPS mixed content。

大型 ASR/VAD 模型的开发服务不建议使用 Uvicorn `--reload`。模型子进程退出后如果 reload 父进程仍持有监听 socket，HTTP 健康检查和 WebSocket 都会表现为连接超时而不是 connection refused。

## 验证约束

自动化测试必须断言：

1. 流式过程从不调用 engine 的离线 `transcribe()`；
2. decoder 收到尾部 1 秒零值 PCM；
3. 至少产生 partial 和 final；
4. 非原生流式 engine 被拒绝。
