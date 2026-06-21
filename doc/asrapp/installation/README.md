# 环境安装与迁移

> **父文档**: [← 返回 ASRAPP 总览](../README.md)
> **子文档**:
> - [后端环境](BACKEND.md)
> - [桌面前端](DESKTOP.md)
> - [Android](ANDROID.md)
> - [第三方库与模型](THIRD_PARTY_MODELS.md)
> - [迁移检查表](MIGRATION.md)

## 推荐部署拓扑

| 服务 | 默认地址 | 必需性 |
|---|---|---|
| FastAPI 后端 | `http://127.0.0.1:8000` | 必需 |
| Electron/Vite | 开发期 `http://127.0.0.1:5173` | 桌面端需要 |
| Higgs Audio SGLang-Omni | `http://127.0.0.1:8002` | Higgs TTS 需要 |
| Redis/Celery | Redis `6379` | 长任务队列可选；本地 eager 模式可不启用 |

建议先安装后端和一个 ASR 模型，验证 `/v1/health`，再安装客户端和其余 GPU 模型。迁移机器时不要复制 `.venv`、`node_modules`、Gradle 缓存或 CUDA 动态库；复制权重和数据，再按目标机器重新安装二进制依赖。

## 最短验证顺序

1. [后端环境](BACKEND.md)：启动后访问 `http://127.0.0.1:8000/v1/health`。
2. [模型清单](THIRD_PARTY_MODELS.md)：加载目标 ASR，并用 `scripts/verify_x_asr_cuda.py` 等脚本验证。
3. [桌面前端](DESKTOP.md)：执行 `npm run build` 或 `npm run dev`。
4. [Android](ANDROID.md)：执行 `./gradlew :app:assembleDebug`。
5. [迁移检查表](MIGRATION.md)：迁移数据、模型、非敏感配置并逐层验收。

