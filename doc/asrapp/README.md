# Amadeus — Agentic Voice Assistant Platform

> **父文档**: [← 返回项目总览](../README.md)
> **子文档**:
> - [架构总览](ARCHITECTURE.md) — 系统鸟瞰图与双架构设计
> - [快速开始](QUICKSTART.md) — 一键启动
> - [环境安装与迁移](installation/README.md) — 后端、桌面、Android、第三方模型
> - [Backend](backend/README.md) — FastAPI 后端服务
> - [Runner](runner/README.md) — 轻量运行时管线
> - [Frontend](frontend/README.md) — 桌面端 + 安卓端
> - [ASR 系统](asr/README.md) — 语音识别引擎
> - [设计决策](design/README.md) — 核心模式与安全

---

## 项目定位

Amadeus 是一个 **AI 语音助手平台**，实现完整的闭环：

```
用户语音 → ASR 识别 → Agent 执行 → TTS 合成 → 语音回复
```

用户通过语音与系统交互，后台由真实的编程 Agent（Claude Code、Codex CLI、OpenCode CLI）执行任务，结果以合成语音反馈。

## 核心链路

| 阶段 | 功能 | 技术 |
|------|------|------|
| 🎤 输入 | 麦克风 / 文件上传 | Electron、Android |
| 📝 ASR | 7 引擎热切换 | FireRedASR2、SenseVoice、Whisper... |
| 🤖 Agent | 真实编程 Agent 执行 | Claude Code、Codex、OpenCode CLI |
| 🧠 记忆 | JSONL 临时/持久记忆 | `.runtime/memory/` |
| 🔊 TTS | 自然语音合成 | GPT-SoVITS、VoxCPM2 |
| 🌐 流式 | X-ASR 原生流式 | WebSocket + VAD 话语边界 |

## 技术栈一览

| 层 | 技术 |
|----|------|
| 后端 | FastAPI + Uvicorn + Celery + Redis |
| 数据库 | SQLAlchemy 2.0 + SQLite |
| 桌面端 | Electron + React + Vite + TypeScript |
| 移动端 | Android (Kotlin + Gradle) |
| 包管理 | uv (Python 3.13) |
| 测试 | pytest + pytest-asyncio |

## 快速链接

- 🚀 [5 分钟快速开始](QUICKSTART.md)
- 🧰 [完整环境安装与迁移](installation/README.md)
- 🏗️ [架构总览](ARCHITECTURE.md)
- 📡 [API 端点详解](backend/API.md)
- 🧩 [ASR 引擎对比](asr/ENGINES.md)
- 🔒 [安全设计](design/SECURITY.md)

## 项目结构

```
asrapp/
├── backend/          # FastAPI 后端（生产级 HTTP/WS 服务）
├── runner/           # 轻量运行时（独立管线，不依赖 FastAPI）
├── frontend/
│   ├── desktop/      # Electron + React 桌面客户端
│   └── android/      # Android 移动端
├── tts/              # GPT-SoVITS 预训练模型
├── data/             # 运行时数据（DB、上传、转录、归档）
├── tests/            # Runner 端测试
├── doc/              # 技术实现文档（backend/desktop/streaming 复现指南）
├── pyproject.toml    # Python 项目配置
└── docker-compose.yaml
```

---

> 📖 点击上方子文档链接深入了解每个模块
