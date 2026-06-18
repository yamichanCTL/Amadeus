# Backend 异步任务系统

> **父文档**: [← 返回 Backend 总览](README.md)

---

## 概述

长音频（>60s）转写使用 Celery + Redis 异步处理，避免 HTTP 请求超时。

## 架构

```
API (FastAPI)               Celery Worker
    │                             │
    ├─ POST /v1/transcribe       │
    │   ├─ 保存音频到磁盘         │
    │   ├─ 创建 task(pending)     │
    │   └─ .delay(task_id) ──────→ 读取 task
    │                              ├─ 加载音频
    │←─ 返回 task_id               ├─ VAD (可选)
    │                              ├─ ASR 推理
    │                              ├─ 标点/说话人 (可选)
    │                              ├─ 写入 transcripts
    └─ GET /v1/tasks/{id} ←─────── └─ status = success/failed
```

## 任务状态

```
pending → processing → success
                     → failed
                     → cancelled
```

## 轮询

客户端使用 `GET /v1/tasks/{task_id}` 轮询，间隔建议 1~1.5s。

终态：`success`、`failed`、`cancelled`。

## 启动 Worker

```bash
cd backend
uv run celery -A app.tasks.celery_app.celery_app worker --loglevel=info --concurrency=1
```

### Windows 启动

```powershell
cd backend
celery -A app.tasks.celery_app.celery_app worker --loglevel=info --pool=solo --concurrency=1
```

## Celery 配置

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `CELERY_BROKER_URL` | `redis://localhost:6379/1` | 消息队列 |
| `CELERY_RESULT_BACKEND` | `redis://localhost:6379/2` | 结果存储 |
| `CELERY_TASK_TIME_LIMIT` | `3600` | 单任务最大秒数 |

## 数据库表

`asr_tasks` 表记录每次识别任务：

| 字段 | 说明 |
|------|------|
| `id` | 任务 UUID |
| `user_id` | 关联用户（可选） |
| `status` | pending/processing/success/failed/cancelled |
| `filename` | 原始文件名 |
| `engine` | 使用的引擎 |
| `celery_id` | Celery 任务 ID |
| `error` | 错误信息 |
| `created_at` / `updated_at` | 时间戳 |

`transcripts` 表存储识别结果：

| 字段 | 说明 |
|------|------|
| `task_id` | 关联任务 |
| `full_text` | 完整文本 |
| `segments` | 分段 JSON |
| `language` | 检测语言 |
| `engine_used` | 实际使用的引擎 |
| `confidence` | 置信度 |

---

> 📖 [API 端点详情 →](API.md) | [部署说明 →](DEPLOY.md)
