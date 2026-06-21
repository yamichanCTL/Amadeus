# Amadeus Backend

> **项目文档**: [后端总览](../doc/asrapp/backend/README.md)
> **安装指南**: [后端环境安装](../doc/asrapp/installation/BACKEND.md)
> **模型指南**: [第三方库与模型](../doc/asrapp/installation/THIRD_PARTY_MODELS.md)

```bash
cd /path/to/asrapp/backend
uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port 8000
```

健康检查：`http://127.0.0.1:8000/v1/health`。
