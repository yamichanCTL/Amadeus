# Router + Fallback 模式

> **父文档**: [← 返回设计决策](README.md)
> **子文档**: [CLI Adapter 模式](CLI_ADAPTER.md)

---

## 优先级链

```
AgentRouter.select_agent()
  ├── 1. Claude Code CLI   → is_available()?
  │     ├─ ✅ → 使用 Claude Code
  │     └─ ❌ → 尝试下一个
  ├── 2. Codex CLI         → is_available()?
  │     ├─ ✅ → 使用 Codex
  │     └─ ❌ → 尝试下一个
  ├── 3. OpenCode CLI      → is_available()?
  │     ├─ ✅ → 使用 OpenCode
  │     └─ ❌ → 尝试下一个
  └── 4. MockAgent         → 永远可用 ✅
```

## 关键行为

| 行为 | 说明 |
|------|------|
| 按优先级尝试 | 第一个可用的即为所选 |
| CLI 不存在不崩溃 | 返回 unavailable，继续下一个 |
| MockAgent 永远可用 | 确保系统零依赖也能跑 |
| 自然语言偏好 | 从输入中检测 Agent 名称（如 "用 claude"） |

## MockAgent

```python
class MockAgent(CliAgentAdapter):
    name = "mock"
    version = "1.0.0"

    def is_available(self) -> bool:
        return True  # 永远可用

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        # 返回模拟结果
        ...
```

MockAgent 是系统的**安全网**，确保在任何环境下都能跑通最小闭环。

## Plugin Registry 模式

ASR 引擎和 Skills 也使用相似的注册表模式：

### ASR 引擎注册

```python
ENGINE_REGISTRY = {
    "fireredasr2": FireRedASR2Config,
    "sensevoice":  SenseVoiceConfig,
    "qwen3asr":    Qwen3ASRConfig,
    "whisper":     WhisperConfig,
}
```

### Skills 注册

```python
SKILL_REGISTRY = {
    "shell":           ShellSkill(),
    "read_file":       ReadFileSkill(),
    "write_file":      WriteFileSkill(),
    "list_dir":        ListDirSkill(),
    "git_clone":       GitCloneSkill(),
    "web_search":      WebSearchSkill(),
    "delegate_agent":  DelegateAgentSkill(),
    ...
}
```

### 注册表优势

- 新引擎/技能可运行时热添加
- 配置驱动，不硬编码
- 统一的生命周期管理（load/unload/status）

---

> 📖 [CLI Adapter 设计 →](CLI_ADAPTER.md) | [引擎管理 →](../backend/ENGINES.md)
