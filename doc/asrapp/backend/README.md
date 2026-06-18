# Backend — FastAPI 后端服务

> **父文档**: [← 返回 asrapp 总览](../README.md)
> **子文档**:
> - [API 端点详解](API.md) — 15 个端点的请求/响应格式
> - [部署说明](DEPLOY.md) — Docker + 手动部署
> - [ASR 引擎管理](ENGINES.md) — 引擎注册、加载、热切换
> - [流式识别](STREAMING.md) — WebSocket VAD 伪流式
> - [异步任务](TASKS.md) — Celery + Redis 长音频处理

---

## 定位

Backend 是生产级 HTTP/WebSocket 服务，提供完整的多用户 ASR + Agent + TTS 能力。

## 技术栈

| 组件 | 技术 |
|------|------|
| Web 框架 | FastAPI + Uvicorn |
| 配置 | Pydantic-settings + `.env` |
| 数据库 | SQLAlchemy 2.0 (async) + SQLite |
| 任务队列 | Celery + Redis |
| 认证 | JWT (python-jose) |
| 音频 | soundfile + librosa + numpy |

## 目录结构

```
backend/
├── .env                     # 环境配置
├── app/
│   ├── main.py              # FastAPI 入口（CORS、GZip、生命周期）
│   ├── config.py            # Pydantic Settings
│   ├── dependencies.py      # DI（DB session、Auth、Model manager）
│   ├── api/
│   │   ├── router.py        # 聚合 12 个子路由
│   │   └── v1/              # health, transcribe, stream, tasks,
│   │                           models, auth, agent_chat, agents,
│   │                           skills, llm, tts_api, voice_api, records
│   ├── core/
│   │   ├── asr/             # ASR 引擎抽象 + 7 引擎实现
│   │   ├── agent_core.py    # LLM Agent 循环
│   │   ├── skill_registry.py # 18+ 技能注册
│   │   ├── streaming/       # WebSocket 流式 ASR
│   │   └── tts/             # TTS 适配
│   ├── db/                  # ORM 模型 + CRUD
│   ├── schemas/             # Pydantic 请求/响应
│   └── tasks/               # Celery 任务定义
├── models/                  # ASR 模型权重 (gitignored)
└── tests/                   # pytest
```

## 启动流程

1. 读取 `.env` 配置
2. 自动创建 `data/`、`models/`、`archive/` 目录
3. 初始化 SQLite 表（`Base.metadata.create_all`）
4. 预加载 `DEFAULT_ENGINE` ASR 模型
5. 注册路由，启动 Uvicorn

## 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口 | [main.py](../../asrapp/backend/app/main.py) | App 工厂、中间件、生命周期 |
| 配置 | [config.py](../../asrapp/backend/app/config.py) | 读取 `.env`，管理所有路径 |
| ASR | [core/asr/](../../asrapp/backend/app/core/asr/) | 引擎抽象、注册、路由、模型管理 |
| Agent | [agent_core.py](../../asrapp/backend/app/core/agent_core.py) | LLM Agent 循环：prompt → LLM → parse 指令 → skill |
| Skills | [skill_registry.py](../../asrapp/backend/app/core/skill_registry.py) | 18+ 技能：shell、文件、git、web、TTS 等 |
| DB | [db/](../../asrapp/backend/app/db/) | User、ASRTask、Transcript 表 |

---

> 📖 [API 端点详解 →](API.md) | [部署说明 →](DEPLOY.md) | [ASR 引擎 →](ENGINES.md)
