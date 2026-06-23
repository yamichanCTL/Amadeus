# Amadeus

Amadeus 是本地优先的语音识别、实时字幕、语音 Agent 与 TTS/变声桌面应用。

```
asr-app/
├── README.md
├── docker-compose.yml
├── .env.example
│
├── backend/                        # Python 后端 (FastAPI)
│   ├── pyproject.toml
│   ├── Dockerfile
│   │
│   ├── app/
│   │   ├── main.py                 # FastAPI 入口，挂载路由
│   │   ├── config.py               # 全局配置 (模型路径, GPU, 限速等)
│   │   ├── dependencies.py         # 依赖注入 (auth, db session)
│   │   │
│   │   ├── api/
│   │   │   ├── router.py           # 聚合所有子路由
│   │   │   ├── v1/
│   │   │   │   ├── transcribe.py   # POST /transcribe  离线识别
│   │   │   │   ├── stream.py       # WS  /stream       流式 (预留)
│   │   │   │   ├── models.py       # GET /models        模型列表/切换
│   │   │   │   ├── tasks.py        # GET /tasks/{id}    任务状态查询
│   │   │   │   └── health.py       # GET /health
│   │   │
│   │   ├── core/
│   │   │   ├── asr/
│   │   │   │   ├── base.py         # ASREngine 抽象基类
│   │   │   │   ├── engines/
│   │   │   │   │   ├── whisper.py  # faster-whisper / openai-whisper
│   │   │   │   │   ├── vosk.py     # Vosk 离线引擎
│   │   │   │   │   ├── sherpa.py   # Sherpa-onnx 引擎
│   │   │   │   │   └── stream_stub.py  # 流式引擎预留桩
│   │   │   │   └── registry.py     # 引擎注册表 (名称→类映射)
│   │   │   │
│   │   │   ├── pipeline/
│   │   │   │   ├── pre/
│   │   │   │   │   ├── vad.py          # VAD 预留 (silero-vad接口)
│   │   │   │   │   └── denoise.py      # 降噪预留
│   │   │   │   └── post/
│   │   │   │       ├── punctuation.py  # 标点恢复 (ct-transformer预留)
│   │   │   │
│   │   │   └── model_manager.py    # 模型加载/卸载/热切换
│   │   │
│   │   ├── tasks/
│   │   │   ├── celery_app.py       # Celery 初始化
│   │   │   └── asr_task.py         # 异步识别任务定义
│   │   │
│   │   ├── db/
│   │   │   ├── models.py           # SQLAlchemy ORM (Task, Transcript, User)
│   │   │   ├── crud.py
│   │   │   └── session.py
│   │   │
│   │   └── schemas/
│   │       ├── transcribe.py       # Pydantic 请求/响应 schema
│   │       └── task.py
│   │
│   ├── models/                     # 模型权重目录 (gitignored)
│   │   ├── whisper/
│   │   ├── vosk/
│   │   └── sherpa/
│   │
│   └── tests/
│       ├── test_engines.py
│       ├── test_pipeline.py
│       └── test_api.py
```
## 使用

```bash
# 1. 安装依赖（whisper 引擎）
uv sync --all-extras

# 2. 启动服务（开发模式，无 Redis）
cd /home/yami/AI/asrapp/backend
uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

## 前端启动
cd /home/yami/AI/asrapp/frontend/desktop
npx vite --host 0.0.0.0
## 1. tts启动 sglang-omni API 服务 (port 8002)
cd /home/yami/AI/audio/TTS/higgs-audio/thirdparty/sglang-omni

PATH="/home/yami/AI/audio/TTS/higgs-audio/thirdparty/sglang-omni/.venv/bin:$PATH" \
FLASHINFER_CUDA_ARCH_LIST=9.0a \
SGLANG_OMNI_STARTUP_TIMEOUT=1800 \
.venv/bin/sgl-omni serve \
  --model-path /home/yami/AI/audio/TTS/higgs-audio/higgs-audio-v3-tts-4b \
  --port 8002 \
  --stages.2.factory_args.server_args_overrides.mem_fraction_static 0.6 \
  --stages.2.factory_args.server_args_overrides.max_running_requests 4


## 2. tts启动 Gradio WebUI (port 8003)
HIGGS_API_BASE=http://127.0.0.1:8002 \
GRADIO_SERVER_NAME=0.0.0.0 \
GRADIO_SERVER_PORT=8003 \
HIGGS_OUTPUT_DIR=/home/yami/AI/audio/TTS/higgs-audio/webui/outputs \
/home/yami/AI/audio/TTS/higgs-audio/.venv/bin/python /home/yami/AI/audio/TTS/higgs-audio/webui.py


## 后台启动
nohup uv run uvicorn app.main:app \
  --host 0.0.0.0 \
  --port 8000 \
  > ../backend.log 2>&1 &

# 3. 运行测试
pytest tests/ -v

# 4. Docker 一键启动（含 Redis + Celery worker）
cd ..
docker-compose up --build
```
API 文档访问：http://localhost:8000/docs
# 打包
cd frontend/desktop
npm run build:win
