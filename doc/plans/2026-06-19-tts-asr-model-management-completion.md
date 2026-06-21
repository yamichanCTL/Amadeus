# 2026-06-19 TTS/ASR 模型管理补齐计划

## 目标

补齐桌面端 TTS 模型管理、变声器 TTS、实时 ASR+TTS、公网后端地址、ASR 模型配置和事件检测下线后的残留问题。

## 执行项

1. 审核当前前端模型页、变声器页、音频 WebSocket 客户端、设置存储和 API 封装，确认哪些功能已经落地、哪些仍有残留。
2. 收窄 TTS 模型设置弹窗，只保留上传、播放、识别参考文本、保存音色等音色配置；常用音色和句首控制标签保持在外层。
3. 加固“语音转 TTS”录音路径，避免 WebSocket 录音结束后提前关闭导致收不到 TTS，并提供录音失败时的清晰状态。
4. 让变声器页刷新运行环境时同步后端已保存音色，便于临时切换。
5. 校验公网 IP 后端地址规范化逻辑，确保 `112.124.13.120:18000` 这种无 scheme 输入会变成 `http://112.124.13.120:18000`，WebSocket 会连到同一主机。
6. 扫描并清理前端暴露的事件检测入口，以及前后端 VOSK、Sherpa、Stream ASR 模型残留。
7. 更新 `doc/CHANGELOG.md` 和相关桌面端文档。
8. 运行 TypeScript、Vite、Python 编译和后端目标测试；无法真实验证的外部硬件/公网连通性要明确标注。

## 测试矩阵

- `frontend/desktop`: TypeScript app 类型检查、node 配置类型检查、Vite 构建。
- `backend/app`: Python compileall。
- `backend/tests`: Higgs TTS API、模型列表、流式会话相关测试。
- 静态扫描：事件检测入口、VOSK/Sherpa/Stream 模型入口、公网 URL 回退问题。
