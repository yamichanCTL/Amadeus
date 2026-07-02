# ASRAPP 快速开始

> **父文档**: [← 返回 asrapp 总览](README.md)

---

## 环境准备

```bash
cd ~/AI/asrapp
uv sync --all-extras           # 安装 Python 依赖
```

## 启动后端

```bash
cd backend
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
# → http://localhost:8000/docs   Swagger API 文档
# → http://localhost:8000/redoc  ReDoc API 文档
```

## 启动桌面客户端

```bash
cd frontend/desktop
npm install
npm run dev
```

## 命令行演示（最小闭环）

```bash
# 纯文本模式
python -m runner.demo.text_to_agent_to_tts_demo "分析项目结构"

# 音频模式
python -m runner.demo.text_to_agent_to_tts_demo --audio 录音.wav --real-tts "转写这段音频"

# 列出可用 Agent
python -m runner.demo.text_to_agent_to_tts_demo --list-agents
```

## Docker 部署

```bash
docker-compose up --build
# 启动: api + worker + redis
```

## 运行测试

```bash
pytest tests/ -v          # Runner 端测试 (7 个)
pytest backend/tests/ -v  # 后端测试 (4 个)
```

## 健康检查

```bash
curl http://localhost:8000/v1/health        # 存活
curl http://localhost:8000/v1/health/ready  # 就绪（检查 DB + 引擎）
```

---

> 📖 [后端部署详解](backend/DEPLOY.md) | [API 端点详情](backend/API.md)
