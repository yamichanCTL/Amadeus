# Runner 技能系统

> **父文档**: [← 返回 Runner 总览](README.md)

---

## 定位

Skill 是**可控小工具**，不是第二套 Agent 框架。大任务交给 CLI Agent，小工具做成 Skill。

## 5 个内置技能

| 技能 | 说明 |
|------|------|
| `get_project_tree` | 获取项目目录结构 |
| `read_text_file` | 读取文本文件内容 |
| `write_temporary_memory` | 写入临时记忆 |
| `get_git_status` | 获取 Git 仓库状态 |
| `run_safe_command` | 运行受限安全命令 |

## Skill 接口

```python
@dataclass
class SkillCall:
    name: str
    args: dict

@dataclass
class SkillResult:
    success: bool
    output: str
    error: str | None
    artifacts: list
```

## 安全约束

- **路径隔离**：文件操作限制在项目目录
- **命令白名单**：`ls`、`find`、`git`、`cat` 等
- **危险拦截**：禁止 `rm -rf`、`sudo`、管道重定向

## 适合/不适合做成 Skill

✅ 适合：
- 读取项目元信息、查找文件、读取配置
- 运行受限命令、写入/查询记忆
- 生成摘要、获取 Git 状态
- 调用 TTS、发送通知

❌ 不适合：
- 自主大规模改代码
- 自主规划复杂任务
- 代替 Claude Code / Codex / OpenCode 执行

---

> 📖 [Backend Skills（18+）→](../backend/README.md) | [安全设计 →](../design/SECURITY.md)
