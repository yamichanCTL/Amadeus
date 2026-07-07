# Backend API 端点详解

> **父文档**: [← 返回 Backend 总览](README.md)
> **子文档**: [流式识别](STREAMING.md) | [异步任务](TASKS.md)

---

所有 API 以 `/v1` 为前缀，完整 Swagger 文档见 `http://localhost:8000/docs`。

## 端点一览

### 健康检查

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/health` | GET | 进程存活检查 |
| `/v1/health/ready` | GET | 就绪检查（验证 DB 连接 + 引擎加载状态） |

### 转写

| 端点 | 方法 | Content-Type | 说明 |
|------|------|-------------|------|
| `/v1/transcribe` | POST | `multipart/form-data` | 音频文件识别（<60s 同步，≥60s 异步） |
| `/v1/stream` | WS | — | WebSocket 流式转写 |

**`POST /v1/transcribe` 表单字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | File | 音频/视频文件 |
| `options` | JSON string | 引擎、语言、超时、标点、热词和归档配置 |

`options` 示例：

```json
{
  "engine": "sensevoice",
  "timeout_sec": 20,
  "language": "zh",
  "enable_punctuation": false,
  "enable_hotwords": true,
  "allow_server_data_collection": false
}
```

`timeout_sec` 默认取后端 `TRANSCRIBE_TIMEOUT_SEC=20`；同步请求与 Celery 异步任务都会限制模型加载加 ASR 推理时长。传 `0` 可关闭该限制，超时的同步请求返回 HTTP 504。

`WS /v1/stream` 和 `WS /v1/tts/higgs/stream` 的致命模型错误返回稳定结构：

```json
{
  "type": "error",
  "code": "gpu_out_of_memory",
  "message": "显存不足：无法加载或运行 x-asr 模型，请先卸载其他 GPU 模型后重试。",
  "model": "x-asr",
  "fatal": true,
  "session_id": "..."
}
```

`code` 只取 `model_not_loaded` 或 `gpu_out_of_memory`。`fatal=true` 表示该错误发送后服务端将以 close code `1011` 结束 WebSocket，客户端不应继续发送音频。

实时 ASR→Higgs WebSocket 还会在新 ASR job 命中近期 TTS 输出时返回非致命回声保护事件：

```json
{
  "type": "echo_suppressed",
  "job_id": 12,
  "text": "我还有好多好多话",
  "matched_tts_text": "我还有好多好多话",
  "window_sec": 8.0
}
```

该事件表示文本不会再次进入 TTS 队列，WebSocket 继续接收后续麦克风音频。

**同步返回（短音频）：**

```json
{
  "task_id": "uuid",
  "status": "success",
  "full_text": "识别结果文本",
  "segments": [],
  "language": "zh",
  "engine_used": "fireredasr2",
  "confidence": null,
  "duration_sec": 12.3,
  "elapsed_sec": 1.2,
  "timing": {
    "model_ready_sec": 0.02,
    "asr_sec": 0.43,
    "punctuation_sec": 0.08,
    "total_sec": 0.61
  }
}
```

**异步返回（长音频）：**

```json
{
  "task_id": "uuid",
  "status": "pending",
  "message": "Task queued. Poll /v1/tasks/{task_id} for status."
}
```

### 任务管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/tasks/{task_id}` | GET | 查询任务状态 |
| `/v1/tasks?limit=&offset=` | GET | 列出任务 |
| `/v1/tasks/{task_id}/cancel` | POST | 取消任务 |

任务状态：`pending` → `processing` → `success` / `failed` / `cancelled`

### 模型管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/models` | GET | 列出所有注册引擎及加载状态 |
| `/v1/models/scheduler` | GET | 查看 ASR 推理调度器配置与队列指标 |
| `/v1/models/{engine}/load` | POST | 加载指定引擎模型 |
| `/v1/models/{engine}/unload` | POST | 卸载指定引擎模型 |

加载 Whisper 示例：

```bash
curl -X POST "http://localhost:8000/v1/models/whisper/load" \
  -H "Content-Type: application/json" \
  -d '{"model_name":"base","device":"cpu","compute_type":"int8"}'
```

调度器指标示例：

```json
{
  "enabled": true,
  "max_batch_items": 4,
  "max_wait_ms": 100,
  "metrics": {
    "submitted": 12,
    "completed": 12,
    "failed": 0,
    "batches": 5,
    "max_batch_size": 4,
    "average_queue_wait_ms": 21.4,
    "max_queue_wait_ms": 98.7,
    "last_batch_engine": "fireredasr2",
    "last_batch_size": 3,
    "last_queue_wait_ms": 45.2
  }
}
```

该端点用于观察短音频、长音频 Celery task 和 Higgs reference ASR 是否都进入统一模型准入队列。`max_wait_ms` 是 micro-batch 聚合上限；模型空闲且队列为空时首个请求会立即执行。

### 认证

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/auth/register` | POST | 用户注册 |
| `/v1/auth/token` | POST | 登录获取 JWT |
| `/v1/auth/me` | GET | 当前用户信息 |

### Agent 对话

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/agent/chat` | POST | Agent 单次对话 |
| `/v1/agent/chat/stream` | POST | Agent 流式对话 |
| `/v1/agent/chat/context` | GET | 获取对话上下文 |
| `/v1/agent/chat/reset` | POST | 重置对话 |
| `/v1/agents` | GET | 列出可用 Agent |

### Skills

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/skills` | GET | 列出所有技能 |
| `/v1/skills` | POST | 执行技能 |

### TTS

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/tts/speak` | POST | 文本转语音 → WAV |
| `/v1/tts/pipeline` | POST | 音频→ASR→Agent→TTS 完整管线 |

### 其他

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/llm/chat` | POST | LLM 调用 |
| `/v1/llm/chat/stream` | POST | LLM 流式调用 |
| `/v1/voice/convert` | POST | 语音转换 |
| `/v1/voice/list` | GET | 列出可用声音 |
| `/v1/records` | GET | 历史转录查询 |
| `/v1/llm/archive-summary` | POST | 总结服务端归档或客户端显式本机记录 |
| `/v1/llm/archive-summary/stream` | POST | 以 NDJSON 流式总结归档或显式本机记录 |

`POST /v1/llm/archive-summary` 可选接收 `records`。一旦提供该字段（包括空数组），后端只使用显式记录，不回退读取服务端归档：

```json
{
  "date": "2026-07-03",
  "category": "实时转录",
  "model": "deepseek-chat",
  "base_url": "https://api.deepseek.com",
  "api_token": "仅用于本次 LLM 请求",
  "prompt": "提取今天的结论和待办",
  "records": [
    {
      "started_at": "2026-07-03T09:10:00+08:00",
      "ended_at": "2026-07-03T09:11:00+08:00",
      "category": "实时转录",
      "text": "只保存在用户电脑上的识别文本"
    }
  ]
}
```

`records` 最多 2000 条，单条文本最多 100000 字符。schema 不接受音频、路径或任意 metadata 字段进入总结构造；最终 LLM 输入只含时间前缀和文本。

桌面端使用 `/v1/llm/archive-summary/stream`。请求体与同步端点相同，响应为 `application/x-ndjson`，事件顺序如下：

- `meta`：记录数、输入字符数、估算 token、日期和时间范围；
- `status`：多分块压缩与最终生成阶段；
- `delta`：可立即追加显示的模型文本；
- `done`：完整 `ArchiveSummaryResult`，客户端收到后才自动保存；
- `error`：流式请求失败原因。

响应设置 `Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no` 和 `Content-Encoding: identity`，避免代理或压缩层把增量事件缓冲到末尾。多分块压缩与最终生成都消费 provider 的流式响应。

---

> 📖 [流式识别协议详情 →](STREAMING.md) | [异步任务机制 →](TASKS.md) | [引擎管理 →](ENGINES.md)
