# CHANGELOG

> **父文档**: [← 返回文档索引](README.md)
> **子文档**:
> - [桌面端文档](desktop/README.md)

## [2026-06-18] 优化 TTS 与 ASR 模型管理

- **类型**: feat / fix
- **描述**: 重构桌面端 TTS 模型设置，将当前音色、句首控制标签和生成参数移出弹窗，弹窗聚焦上传/保存音色；音色改为保存到 `data/tts/voices/<id>/` 并支持参考音频播放和当前 ASR 自动生成参考文本；修复语音转 TTS 停止录音时过早关闭 WebSocket 导致收不到 TTS 的问题；实时 ASR+TTS 改用更小 PCM 块和二进制 WebSocket 帧降低前端传输延迟，并保留输出设备选择；变声器/TTS 增加本次使用音色选择；前后端移除 Vosk、Sherpa、Stream 入口；ASR 模型管理支持展开子模型配置启动设备和参数；后端地址支持 `112.124.13.120:18000` 这类无协议公网地址；前端移除事件检测入口。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/app/api/v1/models.py`、`backend/app/core/asr/registry.py`、`backend/app/core/model_manager.py`、`backend/app/config.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/App.tsx`、`frontend/desktop/src/components/Sidebar.tsx`、`frontend/desktop/src/components/Toolbar.tsx`、`frontend/desktop/src/styles/global.css`、`backend/tests/test_higgs_tts_api.py`、`backend/tests/test_engines.py`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-tts-asr-model-management-optimization.md)

## [2026-06-18] 整理非核心文件到 tmp

- **类型**: chore / docs
- **描述**: 新增项目本地 `tmp/` 归档目录并加入 `.gitignore`，将旧版散落文档、外层总仓归档、文档站生成/缓存产物、根目录样例音频和 Python 构建/缓存产物移入 `tmp/`；同时清理文档站导航与旧链接，保留被 `CHANGELOG` 引用的任务 plan 到 `doc/plans/`。
- **影响范围**: `.gitignore`、`tmp/`、`doc/README.md`、`doc/index.md`、`doc/.vitepress/config.mts`、`doc/asrapp/`、`doc/desktop/README.md`、`doc/plans/`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-project-tmp-cleanup.md)

## [2026-06-18] 配置 VS Code preview 文件打开行为

- **类型**: chore / docs
- **描述**: 新增工作区级 VS Code 设置，让资源管理器单击文件时使用 preview 临时标签，继续单击其他文件会复用该标签，双击文件后固定为常规标签页。
- **影响范围**: `.vscode/settings.json`、`doc/development/README.md`、`doc/README.md`、`doc/.vitepress/config.mts`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-vscode-preview-open-mode.md)

## [2026-06-18] 合并外层 doc 到 asrapp 项目文档

- **类型**: docs
- **描述**: 将 `/home/yami/AI/doc` 合并迁入 `/home/yami/AI/asrapp/doc`。因目标目录已有近期 asrapp 文档、TTS 说明和多个 plan，本次采用合并而非替换：保留现有 `README.md`、`CHANGELOG.md`、桌面端文档和近期计划；迁入外层 VitePress 配置、`asrapp/` 完整文档树、历史 plan、文档站 package 文件，并将外层总仓 README/CHANGELOG 归档到 `doc/archive/root-doc/`。
- **影响范围**: `doc/`、`doc/.vitepress/config.mts`、`doc/asrapp/`、`doc/archive/root-doc/`、`doc/plans/`、`.gitignore`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-merge-root-doc-into-asrapp.md)

## [2026-06-18] TTS 设置弹窗化并新增后端音色库

- **类型**: feat
- **描述**: 桌面端 `模型管理 → TTS 模型设置` 改为紧凑摘要 + 弹窗配置，避免所有 Higgs 参数默认全展开。弹窗支持输入音色名、上传参考音频、填写参考音频链接、准确文本和 Code JSON，并调用后端永久保存本地音色 preset。后端新增本地 Higgs 音色库，`voices` 会合并远端音色和本地保存音色；TTS 请求只传保存过的音色名时，也会自动套用后端保存的参考音频/文本/Code JSON。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/task-plan-20260618-224101-tts-voice-library.md)

## [2026-06-18] 补全 Higgs TTS 音色与控制参数

- **类型**: feat
- **描述**: 对照 `/home/yami/AI/audio/TTS/higgs-audio/webui.py` 补全桌面端 `模型管理 → TTS 模型设置`：新增参考音频 Data URL、参考音频 URL、参考文本、`reference_codes`、句首情绪/风格/韵律控制标签、`aac` 输出格式和流式首个 codec chunk 帧数。后端 Higgs proxy 现在按 webui 的 payload 规则生成 `references` / `reference_codes` 和控制标签，并让文本 TTS、上传音频 ASR→TTS、实时 ASR+TTS 共用这些持久化设置。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-complete-higgs-tts-model-settings.md)

## [2026-06-18] 修复实时 ASR+TTS 输出音频触发自动停止

- **类型**: fix
- **描述**: 修复实时 ASR+TTS 在一句话 VAD 结束并生成 TTS 后自动中断的问题。根因是 `VoiceChangerPage` 的 URL 清理 effect 依赖 `outputAudioUrl`，每次 TTS 返回音频并更新 URL 时都会执行 cleanup，从而调用 `streamClientRef.current?.stop()` 主动关闭 WebSocket。现在 WebSocket 只在组件卸载或用户手动停止时关闭，实时模式会持续监听并对每一句 final ASR 结果执行 TTS。
- **影响范围**: `frontend/desktop/src/pages/VoiceChanger.tsx`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-fix-realtime-tts-url-cleanup-stop.md)

## [2026-06-18] 桌面端 TTS 模型设置迁移与实时 TTS 修复

- **类型**: feat / fix
- **描述**: 在桌面端模型管理新增 `TTS 模型设置`，集中配置 Higgs API 地址、音色、输出格式和生成参数；变声器/TTS 页面移除模型地址与音色配置入口，仅保留工作台操作和输出设备。实时 ASR+TTS 的 WebSocket 关闭事件现在区分主动停止与异常断开，收到一句话 TTS 后保持实时监听。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/README.md`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-desktop-tts-model-settings-realtime.md)

## [2026-06-18] 修复变声器 WebSocket 连接失败 + ASR CPU 模式

- **类型**: fix
- **描述**: 修复前端变声器 WebSocket connection failed 问题。根因：① ASR 引擎默认配置为 GPU (cuda/cuda:0)，GPU 显存已满 (11.3GB/16GB)，导致模型加载时 OOM；② 前端 WebSocket 客户端错误信息不足，且缺少 URL 校验与连接超时检测。修复后将 SenseVoice Small 和 FireRedASR2 改为 CPU 模式，streaming 的 partial/final ASR 统一使用 sensevoice，同时强化前端 WebSocket 客户端的错误诊断能力。
- **影响范围**: `backend/.env`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`
- **Plan**: [链接](plans/2025-06-18-fix-websocket-cpu-asr.md)

### 变更详情
- `backend/.env`:
  - `DEFAULT_ENGINE`: `fireredasr2` → `sensevoice`
  - 新增 `default_sensevoice_device=cpu`
  - 新增 `default_stream_final_engine=sensevoice`
  - `DEFAULT_FIREREDASR2_DEVICE`: `cuda` → `cpu`
  - `DEFAULT_WHISPER_DEVICE`: `cuda` → `cpu`
- `frontend/desktop/src/services/audio.ts`:
  - `StreamingASRClient` / `VoiceTTSStreamingClient`:
  - 新增 `new URL()` 校验，无效地址提前报错
  - `onerror` 消息现包含实际 URL
  - 新增 5s 连接超时检测
  - fallback `final_engine`: `'fireredasr2'` → `'sensevoice'`
- `frontend/desktop/src/store/useASRStore.ts`:
  - `defaultEngine`: `'fireredasr2'` → `'sensevoice'`
  - `selectedEngines`: `['fireredasr2']` → `['sensevoice']`
  - `normalizeSettings()` 新增强健性：空 URL/无协议前缀 URL 自动重置为默认值，去除末尾斜杠；已知过期远程地址 `112.124.13.120:18000` 自动迁移到 `localhost:8000`
- `frontend/desktop/vite.config.ts`:
  - 新增 Vite proxy — `/v1` 转发到 `http://localhost:8000`（含 WebSocket），绕过 WSL2 localhost 转发问题
- `frontend/desktop/src/pages/VoiceChanger.tsx`:
  - 组件挂载时 `console.log` 输出版本和服务 URL，方便诊断

## [2026-06-17] 桌面端 Higgs TTS 与变声器工作台

- **类型**: feat
- **描述**: 新增桌面端变声器/TTS 工作台，支持 Higgs v3 文本 TTS、后端 VAD→ASR→TTS 组合 WebSocket、上传音频 ASR→TTS、实时 ASR→TTS、环节延迟展示和音频输出设备选择。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`、`frontend/desktop/src/components/Sidebar.tsx`、`backend/tests/test_higgs_tts_api.py`、`scripts/verify_higgs_tts_e2e.py`
- **Plan**: [链接到 plan 文件](plans/2026-06-17-desktop-higgs-tts-voice-changer.md)
