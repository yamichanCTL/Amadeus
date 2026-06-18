# 设计决策

> **父文档**: [← 返回 asrapp 总览](../README.md)
> **子文档**:
> - [双架构设计](DUAL_ARCH.md) — Backend vs Runner
> - [Agent-as-CLI-Adapter](CLI_ADAPTER.md) — 核心封装模式
> - [Router + Fallback](ROUTER_FALLBACK.md) — 优先级路由
> - [安全设计](SECURITY.md) — 安全边界

---

## 设计决策索引

| 决策 | 选择 | 原因 |
|------|------|------|
| 架构 | Backend + Runner 双架构 | 生产服务与轻量管线分离 |
| Agent | 封装 CLI，不重新实现 | 避免造轮子，复用成熟工具 |
| 路由 | 优先级链 + MockAgent 兜底 | 系统永远可运行 |
| 注册 | Plugin Registry | 引擎/技能热注册热切换 |
| ASR 流式 | VAD 伪流式 | 离线模型也能近似实时 |
| 记忆 | JSONL 文件 | 无数据库依赖，轻量可审计 |
| 安全 | 路径隔离 + 命令白名单 | 子进程安全边界 |

## 核心原则

1. **不要重新造 Agent**。Agent 层只做 Adapter、Router、日志、权限、超时
2. **大任务交给 CLI Agent**，小而确定的能力才做成 Skill
3. **CLI 不存在时不能崩溃**，必须降级到 MockAgent
4. **发现坏架构优先重构**，不要在上面继续堆功能
5. **每轮改动保持最小可运行验证**

---

> 📖 [双架构设计 →](DUAL_ARCH.md) | [CLI Adapter →](CLI_ADAPTER.md) | [安全设计 →](SECURITY.md)
