# 环境迁移检查表

> **父文档**: [← 返回环境安装总览](README.md)
> **子文档**: [后端环境](BACKEND.md) · [桌面前端](DESKTOP.md) · [Android](ANDROID.md) · [第三方库与模型](THIRD_PARTY_MODELS.md)

## 需要备份

- 源代码及 Git 子仓/第三方源码的确切 commit。
- `backend/models/`、`thirdparty/X-ASR/X-ASR-zh-en/deployment/models/` 和外置 Higgs 权重。
- `data/asr.db`、`data/archive/`、`data/transcripts/`、需要保留的上传文件。
- Higgs 音色预设数据及引用音频；默认后端文件为 `data/higgs_voice_presets.json`，也可由 `ASRAPP_HIGGS_VOICE_PRESETS` 改写路径。
- `.env` 中的非默认路径和服务地址；Token/密钥通过安全渠道单独迁移。

## 不要复制

- `.venv/`、`node_modules/`、`frontend/desktop/release/`、Gradle 缓存和 `local.properties`。
- CUDA/cuDNN 动态库、系统设备 ID、浏览器临时 URL。
- 日志、pytest/Vite 缓存及本机绝对路径。

## 目标机验收

1. `uv sync` 后运行后端测试，并确认 `/v1/health`。
2. 逐个加载需要的 ASR 模型；X-ASR 必须做真实 PCM decode，而不只是 import。
3. 连接 `/v1/stream`，确认依次收到 `accepted`、`ready`、`loading/configured`，且停止后连接立即关闭。
4. 执行 `npm ci && npm run build`，实测麦克风、输出设备、右 Alt 和历史筛选。
5. 执行 `./gradlew :app:assembleDebug`，在真机测试权限、前台服务与网络。
6. 使用 `scripts/test_audio_devices.sh` 验证 WSLg/PulseAudio 输入输出隔离；其他系统使用对应音频工具做同等测试。
7. 如启用 Higgs，先验证 `8002` 健康/模型预热，再运行 `scripts/verify_higgs_tts_e2e.py`。

迁移完成的判据是端到端音频产生正确文本/语音并能可靠停止，不是进程启动或模型状态显示为 loaded。

