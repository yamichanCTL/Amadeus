# Amadeus Backend

> **项目文档**: [后端总览](../doc/asrapp/backend/README.md)
> **安装指南**: [后端环境安装](../doc/asrapp/installation/BACKEND.md)
> **模型指南**: [第三方库与模型](../doc/asrapp/installation/THIRD_PARTY_MODELS.md)

```bash
cd /path/to/asrapp/backend
cp .env.example .env
# 编辑 .env 中的模型、外部源码和 CUDA runtime 路径
uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port 8000
```

后端应用代码不保存机器路径。项目内路径可写相对值：数据目录相对 `PROJECT_ROOT`，模型与外部源码目录相对 `backend/`；机器相关的 CUDA、libstdc++、SenseVoice 和 GPT-SoVITS 路径只写入 `backend/.env`。

健康检查：`http://127.0.0.1:8000/v1/health`。
