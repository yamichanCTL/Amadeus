# Runner Agent 适配器

> **父文档**: [← 返回 Runner 总览](README.md)
> **子文档**: [编排器](ORCHESTRATOR.md) | [设计: CLI Adapter 模式](../design/CLI_ADAPTER.md)

---

## 设计原则

**不重新实现 Agent 逻辑**。通过子进程封装现有 CLI 工具，统一接口。

## 适配器层级

```
                    ┌─────────────────┐
                    │ CliAgentAdapter │  ← 抽象基类 (ABC)
                    │ is_available()  │
                    │ run(task)       │
                    │ name, version   │
                    └────────┬────────┘
           ┌─────────────────┼──────────────────┐
           ▼                 ▼                    ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ClaudeCodeCLI │  │  CodexCLI    │  │ OpenCodeCLI  │
    │claude -p     │  │codex exec    │  │ opencode     │
    └──────────────┘  └──────────────┘  └──────────────┘
```

## 5 个适配器

| 适配器 | 优先级 | 命令 | 说明 |
|--------|--------|------|------|
| **ClaudeCodeCLI** | 1 | `claude -p "<task>"` | Anthropic Claude Code |
| **CodexCLI** | 2 | `codex exec --cd <cwd> --ask-for-approval never -` | OpenAI Codex CLI |
| **OpenCodeCLI** | 3 | `opencode "<task>"` | OpenCode CLI |
| **MockAgent** | 兜底 | 无 | 永远可用，返回模拟结果 |

## 统一接口

所有适配器必须实现：

```python
class CliAgentAdapter(ABC):
    name: str
    version: str

    def is_available(self) -> bool: ...
    def run(self, request: AgentRunRequest) -> AgentRunResult: ...
```

## Router 优先级链

```
AgentRouter
  ├── 1. Claude Code    → 不可用则跳过
  ├── 2. Codex CLI      → 不可用则跳过
  ├── 3. OpenCode CLI   → 不可用则跳过
  └── 4. MockAgent      → 永远可用
```

**额外能力**：支持从自然语言文本中检测 Agent 偏好（如 "用 claude 分析"）。

## MockAgent

- 永远返回 `available: true`
- 返回预设的模拟结果
- 确保系统在没有任何 CLI Agent 时仍可运行

## 安全约束

所有 CLI 调用必须：

1. 工作目录限制在项目根目录
2. 超时控制（默认 300s）
3. 捕获 stdout/stderr/exit_code
4. 不存在的 CLI → 返回 `available: false`，不抛异常
5. 禁止危险命令

---

> 📖 [CLI Adapter 设计模式 →](../design/CLI_ADAPTER.md) | [编排流程 →](ORCHESTRATOR.md)
