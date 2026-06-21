# 修复 Desktop WebSocket 连接超时问题

## 任务目标

解决 Desktop 前端实时语音识别的 WebSocket 连接超时 (5s) 问题。

## 根因分析

### 1. 前端 5s 超时太短
- `StreamingASRClient` 和 `VoiceTTSStreamingClient` 硬编码了 5s 连接超时
- 远程服务器公网延迟 + 反向代理无 WebSocket Upgrade → 连接挂起 → 5s 超时触发

### 2. 后端 VAD 模型加载阻塞
- `StreamingASRSession.__init__()` 中调用 `create_streaming_vad()` 同步加载 FireRed VAD 模型
- 首次加载需 10-30s，期间 WebSocket 虽已 accept 但无消息发回
- 参考 X-ASR 项目：模型加载延迟到 `"start"` 消息，不在连接时加载

### 3. 缺少预检机制
- 客户端直接尝试 WebSocket，失败后才知道不可用
- 没有 HTTP 预检快速判断服务器可达性

### 4. 错误信息不够具体
- 错误消息虽然覆盖了反向代理场景，但没有给出每个 URL 的具体失败原因

## 影响范围

- `backend/app/api/v1/stream.py` — 增加 accepted 消息、loading 心跳
- `backend/app/core/streaming/session.py` — VAD 延迟加载
- `frontend/desktop/src/services/audio.ts` — 增加超时、预检函数、改进错误提示、处理新消息类型

## 实现步骤（实际完成）

1. **后端 `stream.py`**: `websocket.accept()` 后立即发送 `{"type":"accepted"}` 消息
2. **后端 `stream.py`**: VAD 加载超过 3s 时周期性发送 `{"type":"loading","elapsed_s":...}` 心跳
3. **后端 `session.py`**: VAD 创建延迟到首次 `accept_audio()`（对齐 X-ASR 延迟加载模式）
4. **后端 `session.py`**: 增加并发加载保护 `_vad_loading` 标志位
5. **前端 `audio.ts`**: 两个客户端的连接超时从 5s 增加到 15s
6. **前端 `audio.ts`**: 增加 `preflightHealthCheck()` 函数和 `describeWsFailure()` 改进诊断
7. **前端 `audio.ts`**: 两个客户端增加 `accepted` / `loading` 消息处理

## 验证

- TypeScript 类型检查通过
- Python 语法编译通过
- 集成测试：Session 创建即时完成、VAD 按需加载、send_ready 不阻塞
- 向后兼容：新增消息类型在旧客户端被 ignore catch 吞掉，不影响旧版本
