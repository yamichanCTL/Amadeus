# ASR → Codex Agent

> **父文档**：[Backend 总览](README.md)
> **相关文档**：[流式 ASR](STREAMING.md) · [API](API.md)

后端可以把 X-ASR 的最终识别文本直接交给 Codex，返回增量回答、最终结果和真实 token 用量。
同一个 `session_id` 保留多轮上下文。已有离线转录也可以通过 `task_id` 接入。

实现参考 [AInews 的 CodexModel](https://github.com/yamichanCTL/AInews/blob/31c7a1e7bfc1766ac5eee222df159b2808aabf48/server/codex-model.mjs)
和 [AgentLedger](https://github.com/yamichanCTL/AInews/blob/31c7a1e7bfc1766ac5eee222df159b2808aabf48/server/agent-ledger.mjs)：
只导入所选连接、分离应用运行目录、从真实模型事件记账。
本项目使用 Python 连接 [Codex app-server 的 stdio JSONL 协议](https://developers.openai.com/codex/app-server/)，
以获得会话、模型目录和增量事件；无需额外启动 Node 服务。已实测 CLI `0.153.4`。

## 配置

先在运行后端的机器上完成 Codex 登录，或通过 CC Switch 应用提供方配置。
默认读取 `CODEX_HOME`，未设置时读取当前用户的 `~/.codex`。

可在 `backend/.env` 设置：

```dotenv
CODEX_BINARY=codex
# 可选：指定源连接目录，包含 config.toml / auth.json
# CODEX_CONFIG_HOME=/absolute/path/to/.codex
# 可选：应用自己的运行目录，默认 PROJECT_ROOT/.runtime/codex
# CODEX_RUNTIME_DIR=/absolute/path/to/amadeus-codex
CODEX_MAX_SESSIONS=16
CODEX_MAX_ACTIVE_TURNS=2
```

每轮开始读取当前的模型、提供方、推理强度和凭据来源；账号或配置切换后，下一轮会建立新会话。
应用只导入所选提供方配置与登录文件，不复制用户的开发历史、MCP、插件、skills 或项目指令。
应用目录保留自己刷新过的凭据，源账号变化时使用新的独立目录。提供方 `env_key` / `env_http_headers`
引用的环境变量可传入子进程，其他应用密钥不会继承。不要提交或分享 `.runtime/codex`。

本入口沿用 AInews 的“Codex 作为语义处理核心”方式：只读、无交互审批，关闭 shell、插件、外部工具和网页搜索。
适合问答、解释、总结与语音语义处理，不会自动执行语音里的文件修改、部署或 shell 命令。
需要工具执行时应单独定义可授权的工具协议，不应把语音转写直接拼接成 shell 命令。

## 模型与推理强度

`GET /v1/agents/codex/models` 返回：

- `configured_model`、`configured_effort`、`provider`：当前 Codex / CC Switch 配置；
- `models[].id`、`name`、`efforts`、`default_effort`：运行时模型目录；
- `source=codex_catalog` 表示来自 Codex 目录；`configured_provider` 表示额外保留的自定义模型。

在每次请求里传 `model` 和 `effort` 即可选择；省略则跟随当前源配置。
自定义提供方的模型不一定出现在 Codex 官方目录中，所以允许直接传该提供方支持的模型 ID。
目录不是访问权限证明；实际服务拒绝会返回失败，不会换用 mock 或另一个模型。
API 不修改用户的 Codex 全局设置。

## 流式音频接入

连接 `WS /v1/stream`，发送：

```json
{
  "type": "config",
  "engine": "x-asr",
  "language": "zh",
  "agent": {
    "enabled": true,
    "session_id": "voice-demo",
    "effort": "low",
    "timeout_sec": 180
  }
}
```

等待 `configured` 后发送 16 kHz、单声道、16-bit little-endian PCM 二进制帧。
只有非空 `final` 会提交给 Codex，`partial` 不触发调用。同一 ASR job 去重，同一连接按顺序执行，
最多排队 8 段，超出时返回明确错误。未配置 `agent.enabled=true` 时保持纯转录行为。

除原 ASR 事件外，客户端处理：

| 事件 | 内容 |
|---|---|
| `agent.queued` | 已接收最终转录，含 `source_job_id` |
| `agent.started` | `call_id`、`thread_id`、`turn_id`、模型与提供方 |
| `agent.delta` | `text` 回答增量 |
| `agent.completed` | `result`：状态、最终文本、用量、耗时或错误 |
| `agent.error` | 容量、连接或记账错误，不影响已经得到的 ASR 文本 |
| `agent.cancelled` | 已处理客户端取消请求 |

每个 Agent 回答关联原始 `source_job_id`。`agent.completed` 是生命周期终态，
必须检查 `result.status == "completed"` 才能作为成功回答。

发送 `{"type":"end"}` 后，后端先完成 ASR，再继续传送排队中的 Agent 结果，最后发送 `done` 并关闭连接。
发送 `{"type":"agent.cancel"}` 会取消本连接当前的 Agent 调用并清空待处理语音，ASR 连接继续运行。
客户端断开也会停止该连接正在执行的调用。取消会终止实际 Codex 进程，而不是只改变显示状态。

省略 `session_id` 时使用本次 ASR 连接 ID；显式传相同 ID 可跨连接继续上下文。
同一会话不能同时由两个请求执行；HTTP 返回 409，流式事件返回 `codex_busy`。

## 文本或离线 ASR 结果

`POST /v1/agents/codex/turns`：

```json
{"text":"解释一下这句话的意思","session_id":"voice-demo","effort":"low"}
```

也可以先上传音频到 `/v1/transcribe`，取得成功的 `task_id` 后提交：

```json
{"task_id":"已完成的ASR任务ID","session_id":"voice-demo"}
```

后端从转录表读取实际结果；不存在的任务返回 404，未成功的任务返回 409，空文本返回 422。
`text` 和 `task_id` 必须二选一，文本上限 12000 字符。同步、Celery 异步转录的成功结果都可使用。

响应包括 `call_id`、`session_id`、`thread_id`、`turn_id`、`status`、`model`、`provider`、
`effort`、`text`、`usage`、`elapsed_sec`、`error_code`、`error`。
`status` 为 `completed`、`failed`、`cancelled` 或 `timed_out`。
提供方原始错误可能携带凭据，API 只返回固定错误码与可操作提示。

- `POST /v1/agents/codex/sessions/{session_id}/cancel`：取消当前请求；无活动请求时 `cancelled=false`。
- `DELETE /v1/agents/codex/sessions/{session_id}`：取消请求并清除内存上下文，用量记录保留。

## 用量统计

`GET /v1/agents/codex/usage`，可用 `session_id`、`model` 筛选。

统计范围是**本应用发起的调用**，不读取用户其他 Codex 开发会话或 CC Switch 的全局账本。
SQLite 的 `codex_calls` 每轮只记一行，包括模型、提供方、状态、耗时及 token 数量；
不保存 prompt、回答、原始事件或凭据。

计数来源是 `thread/tokenUsage/updated.tokenUsage.total`。同一轮的重复累计快照只更新最新值，
轮结束时减去上一轮基线，避免把同一段历史重复相加。

- `total_tokens = input_tokens + output_tokens`；
- 缓存输入已包含在输入中，推理输出已包含在输出中；
- 缺失或不合法用量为 `null`，增加 `missing_usage`，令 `complete=false`；
- 汇总 token 是已知部分的小计，不能用缺失数据证明“零消耗”；
- `cost`、`remaining_quota` 为 `null`，不把 token 数伪装成账单或剩余额度。

记录先落库才发布终态。重启会把未结束记录标为 `interrupted`，不会自动重放语音请求。
会话上下文仅存活于内存中的 ephemeral thread，重启、取消或闲置会话被容量回收后需要重新开始；用量持续保留。
后端沿用单 worker 部署，每 GPU 一个进程，避免把会话分发到不同进程。

## 验证

自动化协议、取消、隐私、HTTP 和 ASR 桥接测试：

```bash
PYTHONPATH=backend:. .venv/bin/python -m pytest backend/tests/test_codex_runtime.py -q
```

真实端到端测试（需要本机 ASR 模型、ffmpeg 的 flite filter，以及已配置的 Codex 连接）：

```bash
PYTHONPATH=backend:. .venv/bin/python scripts/test_asr_codex_e2e.py
# 指定提供方支持的模型：
PYTHONPATH=backend:. .venv/bin/python scripts/test_asr_codex_e2e.py --model YOUR_MODEL_ID
```

脚本启动独立端口和测试数据库，生成真实语音，经过 WebSocket → X-ASR → Codex → 回答增量与结果，
验证多轮上下文、模型选择、准确记账及后端重启后的用量恢复。任一 gate 不通过即非零退出。
报告和日志位于 `.runtime/asr-codex-e2e/`。

验收记录见 [2026-09-07 测试报告](../../reports/2026-09-07-asr-codex-e2e-report.md)。


## 桌面前端入口

使用原有侧栏的「实时对话」，不再提供独立 Demo 页面。Agent 设定中选择 Codex，选择模型和推理强度；沿用已有后端地址确认、角色 prompt、手动记忆、输入设备和朗读设置。Codex 配置无需在前端填写 LLM Token。

「语音」和「免按键监听」通过已有 StreamingASRClient 将最终 ASR 结果送入后端 Codex，同一会话可继续文字追问。结束语音会停止采集并等待剩余回答；取消回答会取消后端调用，清空会话会重置后端上下文。用量在 Agent 设定和每条回答下显示，未知用量单独提示。

`CodexOptions.context`（最多 16000 字符）传入用户角色设定、手动记忆及可选运行上下文，与当前文本一起作为本轮输入。当前 Codex 接口处理文本对话；看屏幕、自动提取记忆、本地工具指令可切回原有 Agent 使用。立绘在 Codex 模式下跟随聆听、思考、朗读状态。

原界面真实端到端脚本：

```bash
# 先启动后端 8000 和 Vite 5173，使用已安装的 ASR 模型与 Codex 连接。
env -u ELECTRON_RUN_AS_NODE xvfb-run -a \
  frontend/desktop/node_modules/electron/dist/electron --no-sandbox \
  scripts/test_realtime_codex_ui.cjs
```

脚本使用 Chromium 文件麦克风采集合成测试语音，经过原有音频客户端、真实 X-ASR 和真实 Codex，检查结束录音后回答、同会话追问、用量及清空；不使用模拟 ASR 或模拟 Agent。产物在 `.runtime/realtime-codex-ui/`。


## 回声消除与手动提交（2026-09-07 更新）

- 自动朗读默认关闭；设置从版本 40 及更早迁移时关闭旧的开启状态，其他偏好保留。用户以后仍可主动开启。
- 实时对话使用独立的 WebRTC AEC 麦克风音轨：`echoCancellation: true`（优先请求，不把设备是否能满足精确约束作为录音准入条件）。原有预热/离线录音和音频中转音轨刻意禁用 DSP，不能直接复用为有外放的对话输入。现在根据原物理设备 ID 重新打开经过 AEC 的采集，不修改其他功能的原始音轨。
- 如果实际音轨支持 `all`，显式请求系统播放参考；否则使用浏览器原生 AEC。检查 `getSettings()` 的生效状态。系统级 `all` 模式升级采用 `ideal`，遇到不支持的约束时保留已有浏览器 AEC 音轨。设备未启用 AEC 或未报告状态时允许录音，明确显示限制并保持自动朗读关闭，不把裸音轨报告为 AEC 已开启。
- 持续传送采集 PCM，不因 TTS 正在播放而丢帧、静音或关闭麦克风。TTS 取消仍停止过期播放请求，防止迟到的合成结果重新出声。
- Codex 语音使用 `endpointing: "manual"`，录音期间显示实时 partial，用户点击结束才提交完整识别文本；不会因停顿自动调用 Agent。

浏览器 AEC 的语义见 [W3C Media Capture and Streams](https://w3c.github.io/mediacapture-main/#dom-mediatrackconstraintset-echocancellation)。`true` 与 `all` 的覆盖范围取决于浏览器能力，因此信号实验与真实设备体验应分别记录。

算法信号级测试：在 Vite 5173 已启动的 Linux / WSL 环境运行 `.venv/bin/python scripts/test_browser_aec.py`。需要 PulseAudio、ffmpeg、Xvfb 和 Electron；脚本创建并清理自己的虚拟输入/输出，不录制物理麦克风。输出参考经过 80/94/113 ms 的延迟和 0.6/0.18/0.08 的衰减，再叠加独立说话人。测试检查回声能量下降和用户语音保留，不用停止录音或文本去重模拟成功。
