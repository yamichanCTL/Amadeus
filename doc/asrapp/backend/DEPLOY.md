# Backend 部署说明

> **父文档**: [← 返回 Backend 总览](README.md)

---

## 方式一：Docker Compose（推荐生产）

```bash
cd ~/AI/asrapp
docker-compose up --build
```

服务组成：

| 服务 | 镜像 | 端口 | 职责 |
|------|------|------|------|
| `api` | Python 3.11 | 8000 | FastAPI HTTP/WS 服务 |
| `worker` | Python 3.11 | — | Celery 异步任务 Worker |
| `redis` | Redis 7 | 6379 | 消息队列 + 结果后端 |

## 方式二：手动部署

### 1. 安装依赖

```bash
cd ~/AI/asrapp
uv sync --all-extras
sudo apt install -y ffmpeg redis-server
```

### 2. 配置环境变量

编辑 [`backend/.env`](../../asrapp/backend/.env)：

```env
APP_ENV=production
APP_HOST=0.0.0.0
APP_PORT=8000
SECRET_KEY=<your-secret-key>

DATABASE_URL=sqlite+aiosqlite:///../data/asr.db
REDIS_URL=redis://localhost:6379/0
CELERY_BROKER_URL=redis://localhost:6379/1
CELERY_RESULT_BACKEND=redis://localhost:6379/2

DEFAULT_ENGINE=fireredasr2
FIREREDASR2_MODEL_DIR=/path/to/FireRedASR2-AED
```

### 3. 启动 Redis

```bash
sudo service redis-server start
redis-cli ping    # 期望返回 PONG
```

### 4. 启动 API

```bash
cd backend
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 5. 启动 Celery Worker（处理长音频）

```bash
cd backend
uv run celery -A app.tasks.celery_app.celery_app worker --loglevel=info --concurrency=1
```

## 模型文件要求

| 引擎 | 模型目录 | 必需文件 |
|------|----------|----------|
| FireRedASR2 | `FIREREDASR2_MODEL_DIR` | `model.pth.tar`, `cmvn.ark`, `dict.txt` |
| Whisper | `models/whisper/{name}/` | `*.bin` 或 `*.pt` |
| SenseVoice | `models/SenseVoiceSmall/` | SenseVoice 模型文件 |
| Qwen3-ASR | `models/Qwen3-ASR-1.7B/` | Qwen3-ASR 模型文件 |

## 常见问题

### API 启动后无法读取 `.env`

确保工作目录是 `backend/`，`config.py` 使用 `env_file=".env"`。

### `ModuleNotFoundError: No module named 'app'`

从 `backend/` 目录启动，或设置 `PYTHONPATH=backend`。

### 长音频一直 `pending`

检查：Redis 是否启动、Celery Worker 是否启动、API 和 Worker 使用相同的 Broker URL。

---

> 📖 [ASR 引擎配置详情 →](ENGINES.md) | [Backend 总览 →](README.md)
