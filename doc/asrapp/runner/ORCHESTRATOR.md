# Runner 编排器

> **父文档**: [← 返回 Runner 总览](README.md)
> **子文档**: [Agent 适配器](AGENTS.md) | [TTS 引擎](TTS.md) | [记忆系统](MEMORY.md)

---

## 职责

Orchestrator 是 Runner 的大脑，负责调度整个管线，但**不是 Agent 本体**。

## 管线流程

```
1. 接收文本输入（或 ASR 转录结果）
       │
2. 创建任务上下文
       │
3. AgentRouter 选择执行器
   ├── Claude Code → Codex → OpenCode → MockAgent
   └── 按优先级尝试，首个可用即为所选
       │
4. CLI Agent Adapter 执行任务
   ├── 子进程调用，超时控制
   └── 返回结构化 AgentRunResult
       │
5. Context Compressor 压缩结果
   └── 截断长输出 / 生成摘要
       │
6. MemoryManager 写入记忆
   ├── temporary.jsonl (会话级)
   └── agent_runs.jsonl (执行记录)
       │
7. TTSManager 生成语音文本
   ├── 选择语音风格（success/error/fallback）
   └── 调用 TTS 引擎合成音频
       │
8. 返回最终结果 + 日志
```

## 核心数据结构

**AgentRunRequest**：

```python
@dataclass
class AgentRunRequest:
    task: str              # 任务描述
    cwd: str               # 工作目录
    agent_name: str        # 指定 Agent（可选）
    timeout_seconds: int   # 超时 (默认 300)
    dry_run: bool          # 只模拟，不执行
    extra_args: list       # 额外 CLI 参数
    env: dict              # 环境变量
```

**AgentRunResult**：

```python
@dataclass
class AgentRunResult:
    agent_name: str
    success: bool
    available: bool        # CLI 是否可用
    exit_code: int
    stdout: str
    stderr: str
    summary: str           # 压缩后摘要
    started_at: float
    finished_at: float
    duration_seconds: float
    command: str           # 实际执行的命令
    artifacts: list
```

**PipelineTiming**：

```python
@dataclass
class PipelineTiming:
    asr_duration: float
    agent_duration: float
    tts_duration: float
    total_duration: float
```

## 配置

`runner/core/config.py`：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `agent_timeout_seconds` | 300 | Agent 执行超时 |
| `max_capture_chars` | 20000 | 最大输出截断 |
| `memory_dir` | `.runtime/memory/` | 记忆存储路径 |
| `tts_output_dir` | `.runtime/tts_output/` | TTS 音频输出 |

---

> 📖 [Agent 适配器 →](AGENTS.md) | [记忆系统 →](MEMORY.md) | [TTS 引擎 →](TTS.md)
