# 后端环境

> **父文档**: [← 返回环境安装总览](README.md)
> **子文档**: [第三方库与模型](THIRD_PARTY_MODELS.md) · [迁移检查表](MIGRATION.md)

## 前置条件

- Linux（GPU 引擎以 Linux 为主）与 Python `>=3.10,<3.15`；当前机器使用 Python 3.13。
- `uv`、Git/Git LFS、FFmpeg、libsndfile。
- CUDA 模式需要与 PyTorch、ONNX Runtime/sherpa-onnx wheel 匹配的 NVIDIA 驱动、CUDA 12 和 cuDNN 9。不能只凭 `nvidia-smi` 判断运行时兼容。

Ubuntu/WSL 可先安装系统包：

```bash
sudo apt update
sudo apt install -y ffmpeg libsndfile1 git git-lfs curl
git lfs install
```

基础运行库由 `pyproject.toml` 锁定：FastAPI/Uvicorn/WebSocket、Pydantic Settings、SQLAlchemy/aiosqlite、Celery/Redis、soundfile/librosa/numpy、httpx 和结构化日志。ASR、VAD、标点及开发测试库按 extras 安装，避免在 CPU 服务器无条件安装全部 GPU 栈。

## Python 环境

在项目根目录执行：

```bash
cd /path/to/asrapp
uv sync --all-extras
```

如只部署实时 X-ASR，可减少依赖：

```bash
uv sync --extra x-asr --extra dev
```

当前 Python 3.13 + CUDA 12/cuDNN 9 的 sherpa-onnx 专用 wheel 可执行：

```bash
./scripts/install_x_asr_cuda.sh
```

安装后启动必须使用 `uv run --no-sync`，否则通用 lockfile 可能把 CUDA wheel 换回 CPU wheel。

## 配置

后端读取 `backend/.env`。至少按目标机器确认以下字段；路径可以是绝对路径，也可以使用配置类支持的相对路径：

```dotenv
APP_HOST=0.0.0.0
APP_PORT=8000
SECRET_KEY=replace-in-production
DATABASE_URL=sqlite+aiosqlite:///data/asr.db
DEFAULT_ENGINE=fireredasr2
DEFAULT_STREAM_ENGINE=x-asr
X_ASR_MODEL_DIR=../thirdparty/X-ASR/X-ASR-zh-en/deployment/models/chunk-160ms-model
DEFAULT_X_ASR_PROVIDER=cuda
FIREREDASR2_MODEL_DIR=models/fireredasr2/FireRedASR2-AED
FIRERED_VAD_MODEL_DIR=models/fireredasr2/FireRedVAD/Stream-VAD
SENSEVOICE_MODEL_DIR=models/SenseVoiceSmall
QWEN3ASR_MODEL_DIR=models/Qwen3-ASR-1.7B
```

生产环境必须更换 `SECRET_KEY`，并按客户端地址设置 `ALLOWED_ORIGINS`。LLM/TTS Token 不应提交到仓库。

## 启动与验证

```bash
cd /path/to/asrapp/backend
uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port 8000
```

```bash
curl http://127.0.0.1:8000/v1/health
cd /path/to/asrapp
uv run --no-sync pytest backend/tests -q
```

仅需要异步长任务时再启动 Redis/Celery。SQLite 数据、上传、转写和归档默认位于项目 `data/`。
