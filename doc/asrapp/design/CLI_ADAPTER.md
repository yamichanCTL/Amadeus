# Agent-as-CLI-Adapter 设计模式

> **父文档**: [← 返回设计决策](README.md)
> **子文档**: [Router + Fallback](ROUTER_FALLBACK.md)

---

## 设计思想

**不重新实现 Agent 逻辑，通过子进程封装现有 CLI 工具。**

这是一个关键架构决策：

- ❌ 不要在 asrapp 中重新实现代码理解、代码修改、多步规划
- ❌ 不要内嵌完整的 Agent 框架
- ✅ 把 Claude Code、Codex CLI、OpenCode CLI 作为子进程调用
- ✅ 统一接口，统一结果格式

## 类层次

```
                    ┌─────────────────┐
                    │ CliAgentAdapter │  ← 抽象基类
                    │ (ABC)           │
                    └────────┬────────┘
           ┌─────────────────┼──────────────────┐
           ▼                 ▼                    ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ClaudeCodeCLI │  │  CodexCLI    │  │ OpenCodeCLI  │
    │claude -p     │  │codex exec    │  │ opencode     │
    └──────────────┘  └──────────────┘  └──────────────┘
```

## 接口契约

```python
class CliAgentAdapter(ABC):
    name: str
    version: str

    @abstractmethod
    def is_available(self) -> bool:
        """检查 CLI 是否已安装且可执行"""
        ...

    @abstractmethod
    def run(self, request: AgentRunRequest) -> AgentRunResult:
        """子进程执行任务，返回结构化结果"""
        ...
```

## 执行约束

每次 CLI 调用必须：

| 约束 | 实现 |
|------|------|
| 工作目录限制 | `cwd` 绑定项目根目录 |
| 超时控制 | 默认 300s，可配置 |
| 输出捕获 | stdout、stderr 全量收集 |
| 退出码 | 捕获 exit_code，非 0 标记 success=false |
| 可用性 | 不存在则返回 `available: false`，不抛异常 |
| 日志 | 记录命令、耗时、退出码 |

## 为什么这样设计？

| 对比 | 内嵌 Agent | CLI Adapter |
|------|-----------|-------------|
| 维护成本 | 高（需跟进 Agent 更新） | 低（CLI 接口稳定） |
| 功能完整度 | 受限（只实现子集） | 完整（CLI 全部能力） |
| 升级方式 | 改代码 | 升级 CLI 版本 |
| 切换成本 | 高（耦合代码） | 低（替换适配器） |
| 稳定性 | 自己维护 | 依赖成熟工具 |

## 新 Agent 接入

添加新 CLI Agent 只需：

1. 继承 `CliAgentAdapter`
2. 实现 `is_available()` 和 `run()`
3. 在 `AgentRouter` 中注册优先级

---

> 📖 [Router + Fallback →](ROUTER_FALLBACK.md) | [Agent 适配器详情 →](../runner/AGENTS.md)
