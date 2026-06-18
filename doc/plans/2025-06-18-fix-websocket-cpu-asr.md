# Fix: WebSocket Connection Failed + ASR CPU Mode

## Date
2025-06-18

## Goal
解决前端变声器 WebSocket connection failed 问题，并将 ASR 改为 CPU 加载 SenseVoice Small。

## Root Cause Analysis

### 问题1：ASR 引擎配置为 GPU，但 GPU 显存不足
- GPU RTX 5070 Ti (16GB) 已使用 ~11.3GB，仅剩 ~5GB
- `sensevoice` 配置为 `device=cuda:0`
- `fireredasr2` 配置为 `device=cuda`
- `.env` 缺少显式的 CPU 覆盖设置

### 问题2：Streaming pipeline 使用两个 GPU 引擎
- Partial ASR: `sensevoice`（可能在剩余显存下加载但风险高）
- Final ASR: `fireredasr2`（大模型，显存不足时失败）
- VoiceChanger 发送 `finalEngine: settings.defaultEngine` = `'fireredasr2'`

### 问题3：.env 缺少关键 CPU 模式设置
- `.env` 没有 `default_sensevoice_device`、`default_stream_final_engine`
- 所有默认值在 `config.py` 中硬编码为 GPU

### 问题4：前端持久化 URL 指向旧地址
- 用户 localStorage 中 `serverUrl` = `http://112.124.13.120:18000`
- 前端一直往不存在的远程地址连 WebSocket

### 问题5：WSL2 localhost 转发不兼容 WebSocket
- Windows→WSL2 的 localhost 端口转发对 HTTP REST 正常，但对 WebSocket upgrade 请求失效
- 浏览器 `ws://localhost:8000/v1/tts/higgs/stream` → 达不到 WSL2 内的 uvicorn
- 这是 WSL2 已知问题，TCP 层转发未正确处理 WebSocket upgrade

## Fix Summary

### Backend
- `.env`: ASR 引擎全部改为 CPU（sensevoice、fireredasr2、whisper）
- Streaming 的 partial/final ASR 统一使用 `sensevoice`

### Frontend
- Vite dev server 添加 proxy：`/v1` → `http://localhost:8000`（ws: true）
- 前端 `serverUrl` 默认值改为空字符串（same-origin，经 Vite proxy 转发）
- WebSocket/REST 客户端支持空 serverUrl（使用当前页面 origin）
- 增强错误消息（显示实际 URL）+ 5s 连接超时
- 自动迁移已知过期 URL（`112.124.13.120:18000` 等）
- Dev 模式下自动将 `http://localhost:8000` 迁移到空字符串

## Architecture: Vite Proxy (WSL2 解决方案)

```
Browser (Windows)
  │
  │  ws://localhost:5173/v1/tts/higgs/stream
  │  (Vite HMR already works on this port!)
  ▼
Vite Dev Server (:5173, inside WSL2)
  │
  │  ws://localhost:8000/v1/tts/higgs/stream
  │  (internal WSL2 → no forwarding issue)
  ▼
uvicorn (:8000, inside WSL2)
```

## Impact
- **Backend**: `.env` + config.py 默认值
- **Frontend**: services/audio.ts, store, vite.config.ts, VoiceChanger.tsx
- **Streaming**: `/v1/stream` 和 `/v1/tts/higgs/stream`
