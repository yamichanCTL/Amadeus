# ASRAPP 架构总览

> **父文档**: [← 返回 asrapp 总览](README.md)
> **子文档**:
> - [双架构设计](design/DUAL_ARCH.md) — Backend vs Runner
> - [Agent-as-CLI-Adapter](design/CLI_ADAPTER.md) — 核心设计模式
> - [Router + Fallback](design/ROUTER_FALLBACK.md) — 路由与降级
> - [安全设计](design/SECURITY.md) — 安全边界
> - [Backend 详解](backend/README.md)
> - [Runner 详解](runner/README.md)

---

## 系统鸟瞰

```
┌──────────────────────────────────────────────────┐
│                  Frontend 层                      │
│  ┌─────────────────┐  ┌────────────────────────┐ │
│  │ Desktop(Electron)│  │  Android(Kotlin)       │ │
│  └────────┬────────┘  └───────────┬────────────┘ │
└───────────┼────────────────────────┼──────────────┘
            │    HTTP / WebSocket     │
            ▼                         ▼
┌──────────────────────────────────────────────────┐
│                Backend 层 (FastAPI)                │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌─────────────┐ │
│  │ API v1 │ │ Auth │ │ Models │ │ Streaming   │ │
│  │ Router │ │ JWT  │ │ Manager│ │ (WS)        │ │
│  └───┬────┘ └──────┘ └────────┘ └─────────────┘ │
│      │                                             │
│  ┌───┴──────────────────────────────────────────┐ │
│  │              Core Layer                       │ │
│  │  ┌───────┐ ┌────────────┐ ┌───────────────┐ │ │
│  │  │ ASR   │ │ Agent Core │ │ Skill Registry│ │ │
│  │  │ Router│ │ (LLM Loop) │ │ (18+ Skills)  │ │ │
│  │  └───┬───┘ └─────┬──────┘ └───────┬───────┘ │ │
│  │      │           │                │          │ │
│  │  ┌───┴───────────┴────────────────┴───────┐  │ │
│  │  │          TTS Pipeline                  │  │ │
│  │  └────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────┘ │
│  ┌────────┐ ┌────────┐ ┌──────────────────────┐  │
│  │ DB     │ │ Celery │ │ Schemas (Pydantic)   │  │
│  │ SQLite │ │ Redis  │ │ Request/Response     │  │
│  └────────┘ └────────┘ └──────────────────────┘  │
└──────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────┐
│              Runner 层（独立运行时）                │
│  ┌─────────────────────────────────────────────┐ │
│  │        Orchestrator（编排器）                │ │
│  │  text → agent → compress → memory → TTS     │ │
│  └──┬────────┬─────────┬──────────┬───────────┘ │
│     │        │         │          │              │
│  ┌──┴──┐ ┌───┴───┐ ┌───┴────┐ ┌──┴───┐        │
│  │Agent│ │Memory │ │Skills  │ │TTS   │        │
│  │Router│ │Manager│ │Registry│ │Mgr   │        │
│  └─────┘ └───────┘ └────────┘ └──────┘        │
└──────────────────────────────────────────────────┘
```

## 关键设计

| 模式 | 说明 | 详情 |
|------|------|------|
| **双架构** | Backend (FastAPI 生产) + Runner (轻量管线) 独立运行 | [→](design/DUAL_ARCH.md) |
| **CLI Adapter** | 不重写 Agent，封装现有 CLI 工具 | [→](design/CLI_ADAPTER.md) |
| **Router+Fallback** | Claude Code → Codex → OpenCode → MockAgent | [→](design/ROUTER_FALLBACK.md) |
| **Plugin Registry** | ASR 引擎、Skills 均可热注册/热切换 | [→](backend/ENGINES.md) |
| **Pseudo-Streaming** | VAD + 分段离线 ASR 模拟流式 | [→](asr/STREAMING.md) |
| **Security** | 路径隔离、命令白名单、JWT 认证 | [→](design/SECURITY.md) |

## 数据流

```
1. 用户说话 → Frontend 采集 PCM
2. WebSocket/HTTP → Backend ASR 识别 → 文本
3. LLM Agent Loop 分析意图 → 路由 CLI Agent 执行
4. 结果压缩 → Memory 写入 → TTS 合成
5. 音频返回 Frontend 播放 → 用户听到回复
```

---

> 📖 [设计决策详情](design/README.md) | [双架构深入](design/DUAL_ARCH.md) | [安全边界](design/SECURITY.md)
