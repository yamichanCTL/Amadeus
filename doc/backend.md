# ASR Backend 复现技术文档

本文档基于 `D:\project\audio\ASR\ASRAPP\ASR-Backend` 当前源码整理，目标是让开发者只依赖本仓库源码、模型文件和本文档即可完整复现后端服务。

## 1. 项目定位

`ASR-Backend` 是 ASRAPP 的 Python 后端服务，核心能力如下：

- 提供 FastAPI HTTP 服务和 OpenAPI 文档。
- 支持同步短音频转写和异步长音频转写。
- 支持多 ASR 引擎：`fireredasr2`、`wenet`、`whisper`、`vosk`、`sherpa`、`stream`。
- 使用 SQLAlchemy + SQLite 记录用户、任务和识别结果。
- 使用 Redis + Celery 处理长音频异步任务。
- 支持模型加载、卸载和热切换。
- 预留 VAD、标点恢复、说话人分离和 WebSocket 流式识别接口。

默认识别引擎是 `fireredasr2`。短音频在 API 进程内直接识别，超过 `SYNC_MAX_DURATION_SEC` 的音频会创建 Celery 任务，由 Worker 读取临时音频文件并写回数据库结果。

## 2. 推荐环境

建议使用 Linux 或 WSL2 复现完整项目。

| 项目 | 要求 |
|---|---|
| Python | 3.11，见 `.python-version` |
| 包管理 | uv，项目包含 `uv.lock` |
| 系统工具 | ffmpeg |
| 数据库 | 默认 SQLite，无需单独安装 |
| 异步队列 | Redis，长音频和 Celery Worker 需要 |
| GPU | 默认 `fireredasr2` 和 `wenet` 配置为 `cuda`，无 GPU 时需改为 `cpu` |

当前 Windows 原生环境不适合直接用 `uv run` 完整安装：`kaldi-native-fbank==1.15` 没有 `win_amd64` wheel。Windows 上建议使用 WSL2、Linux 容器，或维护一套兼容 Windows 的依赖版本。

## 3. 目录结构

```text
ASR-Backend/
  .python-version
  pyproject.toml
  uv.lock
  README.md
  backend/
    .env
    app/
      main.py
      config.py
      dependencies.py
      api/
      core/
      db/
      schemas/
      tasks/
    tests/
  img/
```

关键模块：

| 路径 | 作用 |
|---|---|
| `backend/app/main.py` | FastAPI 应用入口，配置 CORS、GZip、中间件、生命周期和路由 |
| `backend/app/config.py` | Pydantic Settings，读取 `.env`，创建数据、模型和归档目录 |
| `backend/app/api/router.py` | 聚合所有 `/v1` 路由 |
| `backend/app/api/v1/transcribe.py` | `POST /v1/transcribe`，音频上传、同步/异步识别分流 |
| `backend/app/api/v1/tasks.py` | 任务查询、列表和取消 |
| `backend/app/api/v1/models.py` | 模型列表、加载和卸载 |
| `backend/app/api/v1/auth.py` | 用户注册、登录、JWT 当前用户 |
| `backend/app/api/v1/health.py` | 存活和就绪检查 |
| `backend/app/api/v1/stream.py` | WebSocket 流式识别占位接口 |
| `backend/app/core/model_manager.py` | 模型单例管理、懒加载、热切换、卸载 |
| `backend/app/core/asr/registry.py` | ASR 引擎注册表 |
| `backend/app/core/asr/router.py` | 单引擎/多引擎调度与结果合并 |
| `backend/app/tasks/celery_app.py` | Celery 应用和 Worker 生命周期 |
| `backend/app/tasks/asr_task.py` | 长音频异步识别任务 |
| `backend/app/db/models.py` | `users`、`asr_tasks`、`transcripts` 表模型 |
| `backend/tests/` | pytest 测试，使用 mock ASR 引擎 |

当前源码没有 `Dockerfile` 和 `docker-compose.yml`，虽然 README 中提到了 Docker 启动方式，实际复现应以本文件的本地/WSL 启动流程为准。

## 4. 依赖安装

在 Linux/WSL2 中执行：

```bash
cd /mnt/d/project/audio/ASR/ASRAPP/ASR-Backend
uv sync --extra dev --extra torch
```

如需安装可选引擎依赖：

```bash
uv sync --extra dev --extra torch --extra whisper
uv sync --extra dev --extra torch --extra whisper --extra vosk --extra sherpa
uv sync --extra dev --extra torch --extra wenet
```

`pyproject.toml` 中的主要依赖：

- Web：`fastapi`、`uvicorn[standard]`、`python-multipart`、`websockets`
- 配置：`pydantic`、`pydantic-settings`、`python-dotenv`
- 数据库：`sqlalchemy`、`aiosqlite`、`alembic`
- 队列：`celery[redis]`、`redis`
- 音频：`soundfile`、`librosa`、`numpy<2`、`pyyaml`
- 鉴权：`python-jose[cryptography]`、`passlib[bcrypt]`
- FireRed/Wenet 相关：`torch==2.1.0`、`torchaudio==2.1.0`、`kaldi-native-fbank==1.15`、`sentencepiece`、`transformers==4.51.3`

系统还需要安装 ffmpeg，例如：

```bash
sudo apt update
sudo apt install -y ffmpeg redis-server
```

## 5. 配置文件

后端配置文件位于：

```text
ASR-Backend/backend/.env
```

注意：`config.py` 使用 `env_file=".env"`，所以启动 API 和 Celery 时建议工作目录为 `ASR-Backend/backend`，否则不会自动读取 `backend/.env`。

最小可运行配置示例：

```env
APP_ENV=development
APP_HOST=0.0.0.0
APP_PORT=8000
APP_LOG_LEVEL=info
SECRET_KEY=change-me-in-production

DATABASE_URL=sqlite+aiosqlite:///./data/asr.db
REDIS_URL=redis://localhost:6379/0
CELERY_BROKER_URL=redis://localhost:6379/1
CELERY_RESULT_BACKEND=redis://localhost:6379/2

MODELS_DIR=./models
AUDIO_UPLOAD_DIR=./data/uploads
TRANSCRIPT_DIR=./data/transcripts
ARCHIVE_DIR=./data/archive

DEFAULT_ENGINE=fireredasr2
DEFAULT_WHISPER_MODEL=base
DEFAULT_WHISPER_DEVICE=cuda
DEFAULT_WHISPER_COMPUTE_TYPE=int8
DEFAULT_VOSK_MODEL=vosk-model-cn-0.22
DEFAULT_SHERPA_MODEL=sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20

ENABLE_VAD=false
ENABLE_DENOISE=false
ENABLE_PUNCTUATION=false
ENABLE_DIARIZE=false

MAX_UPLOAD_SIZE_MB=500
SYNC_MAX_DURATION_SEC=60
CELERY_TASK_TIME_LIMIT=3600
ACCESS_TOKEN_EXPIRE_MINUTES=60
ALGORITHM=HS256

FIREREDASR2_SRC_PATH=D:\project\audio\ASR\ASRAPP\ASR-Backend\backend\app\core\asr\engines
DEFAULT_FIREREDASR2_MODEL=FireRedASR2-AED
DEFAULT_FIREREDASR2_DEVICE=cuda
FIREREDASR2_MODEL_DIR=D:\project\audio\model\pretrained_models\FireRedASR2-AED
FIREREDASR2_BEAM_SIZE=3
FIREREDASR2_BATCH_SIZE=4
FIREREDASR2_BATCH_WAIT_MS=50
FIREREDASR2_MAX_CONCURRENT=1
FIREREDASR2_WORKER_THREADS=4
FIREREDASR2_RETURN_TIMESTAMP=true

DEFAULT_WENET_MODEL=FireRed-Wenet-1B
DEFAULT_WENET_DEVICE=cuda
WENET_MODEL_DIR=./models/wenet/FireRed-Wenet-1B
WENET_CHECKPOINT=exp43_best10_20w.pt
WENET_CONFIG=
WENET_DECODE_MODE=ctc_greedy_search
WENET_BATCH_SIZE=1
WENET_BEAM_SIZE=10
WENET_ATTENTION_BEAM_SIZE=3
WENET_CTC_WEIGHT=0.3
WENET_REVERSE_WEIGHT=0.5
WENET_BLANK_PENALTY=0
WENET_LENGTH_PENALTY=0.6
WENET_DECODING_CHUNK_SIZE=-1
WENET_NUM_DECODING_LEFT_CHUNKS=0
WENET_DTYPE=fp32
WENET_IS_1B=true
```

无 GPU 复现时，把以下配置改为 `cpu`：

```env
DEFAULT_FIREREDASR2_DEVICE=cpu
DEFAULT_WENET_DEVICE=cpu
DEFAULT_WHISPER_DEVICE=cpu
DEFAULT_WHISPER_COMPUTE_TYPE=int8
```

## 6. 模型文件要求

### 6.1 FireRedASR2

默认引擎 `fireredasr2` 使用 `backend/app/core/asr/engines/fireredasr2_aed.py`。

模型目录由 `FIREREDASR2_MODEL_DIR` 指定，目录必须包含：

```text
model.pth.tar
cmvn.ark
dict.txt
```

`FIREREDASR2_SRC_PATH` 应指向包含 `fireredasr2/` Python 包的父目录。当前仓库内已有：

```text
backend/app/core/asr/engines/fireredasr2/
```

因此通常可以设置为：

```text
ASR-Backend/backend/app/core/asr/engines
```

### 6.2 Wenet

`wenet` 引擎使用 `backend/app/core/asr/engines/wenet/engine.py`，源码包位于：

```text
backend/app/core/asr/engines/wenet/wenet/
```

`WENET_MODEL_DIR` 必须包含：

```text
global_cmvn
train_bpe1000.model
units.txt
```

同时还需要 checkpoint 文件，例如：

```text
exp43_best10_20w.pt
```

如果没有设置 `WENET_CONFIG`，默认使用：

```text
backend/app/core/asr/engines/wenet/resources/conf/train_firered2_offline_expand_vocab.yaml
```

### 6.3 Whisper

`whisper` 引擎依赖 `faster-whisper`。模型目录规则：

```text
models/whisper/{model_name}/
```

如果本地目录不存在模型权重，`faster-whisper` 会尝试联网下载到 `models/whisper`。离线复现时应提前准备模型文件，目录中应有 `*.bin` 或 `*.pt`。

### 6.4 Vosk

`vosk` 引擎目录规则：

```text
models/vosk/vosk-model-cn-0.22/
```

没有本地目录时会直接报错。模型需从 Vosk 官方模型发布页下载后解压。

### 6.5 Sherpa

`sherpa` 引擎目录规则：

```text
models/sherpa/{model_name}/
```

典型 ONNX 模型文件：

```text
encoder*.onnx
decoder*.onnx
joiner*.onnx
tokens.txt
```

或 CTC 模型：

```text
*.onnx
tokens.txt
```

## 7. 启动服务

### 7.1 启动 Redis

Linux/WSL2：

```bash
sudo service redis-server start
redis-cli ping
```

期望返回：

```text
PONG
```

### 7.2 启动 API

因为 `.env` 在 `backend/` 下，建议从 `backend/` 目录启动：

```bash
cd /mnt/d/project/audio/ASR/ASRAPP/ASR-Backend/backend
../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Windows PowerShell 使用已有兼容虚拟环境时：

```powershell
cd D:\project\audio\ASR\ASRAPP\ASR-Backend\backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

启动时会执行：

1. 读取 `.env`。
2. 自动创建 `data/`、`models/`、`archive/` 等目录。
3. 初始化 SQLite 表。
4. 尝试预加载 `DEFAULT_ENGINE`。

如果默认模型文件缺失，服务仍会启动，但 `/v1/health/ready` 或首次识别会暴露模型加载错误。

### 7.3 启动 Celery Worker

长音频异步识别需要单独启动 Worker。

Linux/WSL2：

```bash
cd /mnt/d/project/audio/ASR/ASRAPP/ASR-Backend/backend
../.venv/bin/celery -A app.tasks.celery_app.celery_app worker --loglevel=info --concurrency=1
```

Windows 调试时建议使用 `solo` 池：

```powershell
cd D:\project\audio\ASR\ASRAPP\ASR-Backend\backend
..\.venv\Scripts\celery.exe -A app.tasks.celery_app.celery_app worker --loglevel=info --pool=solo --concurrency=1
```

Worker 启动后也会尝试预加载默认引擎。

## 8. API 接口

服务启动后访问：

```text
http://localhost:8000/docs
http://localhost:8000/redoc
```

### 8.1 健康检查

```http
GET /v1/health
GET /v1/health/ready
```

`/v1/health` 只检查进程存活。`/v1/health/ready` 会检查数据库和引擎注册/加载状态。

### 8.2 转写

```http
POST /v1/transcribe
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 说明 |
|---|---|
| `file` | 音频或含音频的视频文件 |
| `options` | JSON 字符串，可选 |

`options` 示例：

```json
{
  "engines": ["fireredasr2"],
  "language": "zh",
  "enable_punctuation": false,
  "enable_diarize": false,
  "merge_strategy": "first",
  "allow_server_data_collection": false,
  "archive_dir": ""
}
```

允许的上传 MIME 类型包括：

```text
audio/wav
audio/x-wav
audio/mpeg
audio/mp4
audio/x-m4a
audio/ogg
audio/flac
audio/webm
video/mp4
video/webm
application/octet-stream
```

短音频同步返回：

```json
{
  "task_id": "...",
  "status": "success",
  "full_text": "...",
  "segments": [],
  "language": "zh",
  "engine_used": "fireredasr2",
  "confidence": null,
  "duration_sec": 12.3,
  "elapsed_sec": 1.2,
  "timing": {}
}
```

长音频异步返回：

```json
{
  "task_id": "...",
  "status": "pending",
  "message": "Task queued. Poll /v1/tasks/{task_id} for status.",
  "timing": {}
}
```

curl 示例：

```bash
curl -X POST "http://localhost:8000/v1/transcribe" \
  -F "file=@sample.wav;type=audio/wav" \
  -F 'options={"engines":["fireredasr2"],"language":"zh"}'
```

### 8.3 任务管理

```http
GET  /v1/tasks/{task_id}
GET  /v1/tasks?limit=20&offset=0
POST /v1/tasks/{task_id}/cancel
```

任务状态：

```text
pending
processing
success
failed
cancelled
```

查询异步任务：

```bash
curl "http://localhost:8000/v1/tasks/{task_id}"
```

### 8.4 模型管理

```http
GET  /v1/models
POST /v1/models/{name}/load
POST /v1/models/{name}/unload
```

可用引擎：

```text
fireredasr2
sherpa
stream
vosk
wenet
whisper
```

加载 Whisper：

```bash
curl -X POST "http://localhost:8000/v1/models/whisper/load" \
  -H "Content-Type: application/json" \
  -d '{"model_name":"base","device":"cpu","compute_type":"int8"}'
```

加载 FireRedASR2：

```bash
curl -X POST "http://localhost:8000/v1/models/fireredasr2/load" \
  -H "Content-Type: application/json" \
  -d '{"model_name":"FireRedASR2-AED","device":"cuda"}'
```

### 8.5 鉴权

鉴权是可选能力，匿名用户也可以提交任务。

```http
POST /v1/auth/register
POST /v1/auth/token
GET  /v1/auth/me
```

注册：

```bash
curl -X POST "http://localhost:8000/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"password123"}'
```

登录：

```bash
curl -X POST "http://localhost:8000/v1/auth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=demo&password=password123"
```

### 8.6 WebSocket

```text
WS /v1/stream
```

当前只是占位接口。连接后会返回 `NOT_IMPLEMENTED`，然后关闭连接。实际实时流式识别尚未实现。

## 9. 数据库

默认数据库：

```text
backend/data/asr.db
```

表结构：

| 表 | 作用 |
|---|---|
| `users` | 可选用户系统，保存用户名、密码 hash、启用状态 |
| `asr_tasks` | 每次识别任务，保存文件、引擎、状态、Celery ID、错误和时间 |
| `transcripts` | 最终识别结果，保存全文、分段、语言、引擎、置信度和原始结果 |

应用启动时调用 `Base.metadata.create_all` 自动建表。生产环境如需迁移管理，应补充 Alembic migration。

## 10. 识别流程

### 10.1 同步短音频

```text
POST /v1/transcribe
  -> 校验文件类型和大小
  -> 读取音频字节
  -> soundfile 探测时长
  -> 创建 asr_tasks 记录
  -> duration <= SYNC_MAX_DURATION_SEC
  -> ModelRouter 调用一个或多个引擎
  -> 可选标点/说话人后处理
  -> 写入 transcripts
  -> asr_tasks.status = success
  -> 返回 TranscribeResponse
```

### 10.2 异步长音频

```text
POST /v1/transcribe
  -> 创建 asr_tasks 记录
  -> 保存上传音频到 AUDIO_UPLOAD_DIR 或 ARCHIVE_DIR
  -> run_asr_task.delay(task_id)
  -> 返回 task_id

Celery Worker
  -> 读取 asr_tasks
  -> status = processing
  -> 读取音频文件
  -> 可选 VAD
  -> ModelRouter 调用 ASR 引擎
  -> 可选标点/说话人后处理
  -> 写入 transcripts
  -> status = success 或 failed
  -> 如未允许数据归档，删除临时音频
```

## 11. 测试与验证

源码语法检查：

```powershell
cd D:\project\audio\ASR\ASRAPP\ASR-Backend
python -m compileall backend\app
```

当前检查结果：已通过。

pytest 推荐在 Linux/WSL2 完成依赖安装后执行：

```bash
cd /mnt/d/project/audio/ASR/ASRAPP/ASR-Backend
uv run pytest backend/tests -q
```

当前 Windows 原生环境执行 `uv run pytest backend\tests -q` 会失败，原因是：

```text
kaldi-native-fbank==1.15 没有 win_amd64 wheel
```

测试使用 `backend/tests/conftest.py` 中的 `MockASREngine`，理论上不需要真实模型文件，但仍需要先安装项目依赖。

## 12. 复现验收清单

1. Python 3.11 环境可用。
2. `uv sync` 在 Linux/WSL2 中安装完成。
3. ffmpeg 可执行：`ffmpeg -version`。
4. Redis 可用：`redis-cli ping` 返回 `PONG`。
5. `backend/.env` 路径配置正确，尤其是模型路径。
6. 默认引擎模型文件存在。
7. API 从 `backend/` 目录成功启动。
8. `GET /v1/health` 返回 200。
9. `GET /v1/models` 能列出所有注册引擎。
10. `POST /v1/models/fireredasr2/load` 能加载默认模型。
11. 短音频 `POST /v1/transcribe` 返回 `success` 和 `full_text`。
12. Redis 和 Celery Worker 启动后，长音频返回 `pending`，轮询 `/v1/tasks/{task_id}` 最终得到 `success` 或明确错误。
13. `backend/data/asr.db` 中生成 `asr_tasks` 和 `transcripts` 记录。
14. `python -m compileall backend/app` 通过。
15. Linux/WSL2 中 `uv run pytest backend/tests -q` 通过。

## 13. 常见问题

### 13.1 启动后没有读取 `.env`

确认当前工作目录是：

```text
ASR-Backend/backend
```

如果从 `ASR-Backend` 根目录启动，需要复制 `.env` 到根目录，或显式设置环境变量。不建议这样做，因为 `data/` 等相对路径也会改变。

### 13.2 `ModuleNotFoundError: No module named 'app'`

说明 Python 模块搜索路径没有包含 `backend/`。使用以下方式之一：

```bash
cd ASR-Backend/backend
../.venv/bin/python -m uvicorn app.main:app
```

或从根目录显式设置：

```bash
PYTHONPATH=backend .venv/bin/python -m uvicorn app.main:app
```

### 13.3 FireRedASR2 加载失败

检查：

- `FIREREDASR2_SRC_PATH` 是否指向包含 `fireredasr2/` 的父目录。
- `FIREREDASR2_MODEL_DIR` 是否存在。
- 模型目录是否包含 `model.pth.tar`、`cmvn.ark`、`dict.txt`。
- `DEFAULT_FIREREDASR2_DEVICE` 是否与机器能力一致。

### 13.4 Wenet 加载失败

检查：

- `WENET_MODEL_DIR` 是否存在。
- 是否包含 `global_cmvn`、`train_bpe1000.model`、`units.txt`。
- `WENET_CHECKPOINT` 是否存在于 `WENET_MODEL_DIR` 下，或配置为绝对路径。
- `WENET_CONFIG` 是否存在；为空时使用源码内默认配置。

### 13.5 长音频一直 pending

检查：

- Redis 是否启动。
- Celery Worker 是否启动。
- API 和 Worker 是否使用同一个 `CELERY_BROKER_URL`、`CELERY_RESULT_BACKEND` 和 `DATABASE_URL`。
- API 保存的 `audio_path` 对 Worker 是否可见。如果 API 和 Worker 在不同容器或机器上，需要共享上传目录。

### 13.6 Windows 上依赖安装失败

这是当前依赖组合的已知限制。`kaldi-native-fbank==1.15` 没有 Windows wheel。完整复现建议切换到 WSL2/Linux。

### 13.7 README 显示乱码或内容与源码不一致

当前 `README.md` 和部分源码注释在 PowerShell 输出中存在编码乱码。复现以后端源码和本文档为准。README 中提到的 Docker 文件当前仓库不存在。

## 14. 版本控制建议

应纳入版本控制：

```text
ASR-Backend/pyproject.toml
ASR-Backend/uv.lock
ASR-Backend/.python-version
ASR-Backend/backend/app/
ASR-Backend/backend/tests/
ASR-Backend/README.md
```

不应纳入版本控制：

```text
ASR-Backend/.venv/
ASR-Backend/backend/data/
ASR-Backend/backend/models/
ASR-Backend/backend/.env
ASR-Backend/backend/__pycache__/
ASR-Backend/backend/.pytest_cache/
```

当前 `.gitignore` 只忽略了 `.venv`、缓存和构建产物，建议后续补充：

```gitignore
backend/.env
backend/data/
backend/models/
backend/.pytest_cache/
```
