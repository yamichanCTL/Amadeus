# 双架构设计

> **父文档**: [← 返回设计决策](README.md)

---

## 为什么是双架构？

ASRAPP 有两个独立运行层，解决不同场景的需求。

## Backend（FastAPI 生产服务）

| 维度 | 说明 |
|------|------|
| 定位 | 生产级 HTTP/WebSocket 服务 |
| 职责 | 用户管理、离线 ASR、X-ASR 原生流式识别、LLM Agent 对话、任务队列 |
| 依赖 | FastAPI、SQLAlchemy、Celery、Redis |
| 场景 | Docker 部署、多用户服务、Web/App 客户端接入 |

## Runner（独立运行时库）

| 维度 | 说明 |
|------|------|
| 定位 | 轻量级管线库 |
| 职责 | 编排 Agent→TTS 闭环、命令行演示 |
| 依赖 | 纯 Python，最小化第三方依赖 |
| 场景 | CLI 演示、嵌入式调用、快速原型 |

## 关键差异

| 方面 | Backend | Runner |
|------|---------|--------|
| 服务方式 | HTTP/WS 服务 | 本地管线 |
| 并发 | 多用户 | 单会话 |
| 异步 | Celery + Redis | 同步执行 |
| 存储 | SQLite | JSONL 文件 |
| ASR | 7 引擎完整实现 | faster-whisper |
| 启动 | Uvicorn + Worker | Python 直接运行 |

## 共享部分

两者共享：
- TTS/ASR 适配层的设计模式
- Agent 适配器的接口抽象
- Skill 的结构化输入输出模式

## 关系图

```
Backend (FastAPI)          Runner (Standalone)
     │                          │
     ├─ 生产级                  ├─ 原型/演示
     ├─ 多用户                  ├─ 单会话
     ├─ API 驱动               ├─ CLI 驱动
     └─ 可独立运行              └─ 可独立运行
```

两部分**互不依赖**，可以独立开发、测试、部署。

---

> 📖 [架构总览 →](../ARCHITECTURE.md) | [Backend 详解 →](../backend/README.md) | [Runner 详解 →](../runner/README.md)
