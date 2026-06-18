# Backend 流式识别

> **父文档**: [← 返回 Backend 总览](README.md)
> **子文档**: [伪流式 ASR 设计详情](../asr/STREAMING.md)

---

## 概述

Backend 支持 WebSocket 流式识别，基于 VAD 驱动的伪流式方案：
离线 ASR 引擎本身不支持流式，通过 VAD 检测 + 分段调用模拟实时体验。

## WebSocket 协议

**端点**：`WS /v1/stream`

### 客户端 → 服务端

```json
{
  "type": "audio",
  "sample_rate": 16000,
  "format": "pcm_s16le",
  "data": "<base64 encoded PCM>"
}
```

### 服务端 → 客户端 (Partial)

```json
{
  "type": "partial",
  "session_id": "xxx",
  "stable_text": "我想打开",
  "unstable_text": "微信",
  "text": "我想打开微信"
}
```

### 服务端 → 客户端 (Final)

```json
{
  "type": "final",
  "session_id": "xxx",
  "text": "我想打开微信",
  "duration_sec": 2.34,
  "engine": "fireredasr2"
}
```

## 流程

```
Client 持续发送 PCM chunks
  → VAD 检测 speech 开始
  → 累积音频 + 500ms 间隔触发 partial ASR
  → UI 显示 stable/unstable 文本 (LCP 算法)
  → VAD 检测 silence ≥ 700ms
  → 完整音频段 final ASR（可使用更高精度引擎）
  → final 替换 partial
  → 回到 IDLE 等待下一句
```

## 状态机

```
IDLE → SPEAKING → PARTIAL → FINAL → IDLE
```

| 状态 | 条件 |
|------|------|
| IDLE | 等待语音 |
| SPEAKING | 连续 200ms 语音检测到 |
| PARTIAL | 每 500ms 跑一次 partial ASR |
| FINAL | 静音 ≥ 700ms，完整 ASR |

## 关键参数

```yaml
vad:
  start_speech_ms: 200      # 连续语音确认阈值
  end_silence_ms: 700       # 静音判定阈值
  max_segment_ms: 10000     # 最长语音段（强制切句）
  pre_roll_ms: 300          # 回溯音频防止丢字

partial:
  infer_interval_ms: 500    # partial 推理间隔
  stable_times: 2           # LCP 稳定次数
  max_concurrent_jobs: 1    # 同一 session 串行
```

---

> 📖 [VAD 伪流式完整设计 →](../asr/STREAMING.md)
