# 2026-06-19 修复 TTS 参考音频 ASR Failed to fetch 计划

## 目标

排查并修复 `模型管理 -> TTS 模型设置 -> 当前 ASR 生成并填充` 出现 `Failed to fetch` 导致无法生成预填充文本的问题。

## 影响范围

- `frontend/desktop/src/services/api.ts`
- `frontend/desktop/src/pages/Models.tsx`
- `backend/app/main.py`（如确认为 CORS/公网来源问题）
- `doc/desktop/TTS_VOICE.md`
- `doc/CHANGELOG.md`

## 排查步骤

1. 检查前端请求 URL 生成逻辑：空 `serverUrl`、公网 `host:port`、Vite 代理和 Electron 场景。
2. 用 `curl` 验证当前 Vite 代理 `/v1/health` 与后端 `/v1/health` 连通性。
3. 检查后端 CORS 是否允许桌面端开发地址、公网地址和 Electron/file 来源。
4. 加强 `referenceAudioAsr()` 的错误处理，让浏览器网络失败能提示实际请求地址和后端地址配置建议。
5. 如同源代理失败且配置了可推断后端地址，提供直接请求后端的回退路径。
6. 更新文档和 CHANGELOG，并运行前端类型检查、构建、后端编译和目标测试。

## 风险评估

- 浏览器的 `TypeError: Failed to fetch` 不暴露底层网络细节，需要通过 URL、代理和 CORS 辅助定位。
- 不能把所有请求都盲目改为直连公网，否则会破坏当前 Vite 代理规避 WSL2 WebSocket 问题的路径。
- 修复应尽量限制在参考音频 ASR 这条链路，避免影响已有转写、TTS 和实时 WebSocket。
