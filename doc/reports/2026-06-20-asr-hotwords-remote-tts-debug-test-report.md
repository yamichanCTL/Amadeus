# 2026-06-20 ASR / 热词 / 远程 TTS / 调试台测试报告

## 结论

九项需求的代码路径、单元测试、真实 X-ASR CUDA 音频和桌面生产构建均已验证。已安装官方 `sherpa-onnx 1.13.2+cuda12.cudnn9`；RTX 5070 Ti 加载模型后显存增加 1359 MiB，不再出现 CPU fallback。

## 逐项结果

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | ASR 默认 CUDA | 通过 | FireRed/Whisper/X-ASR 默认 `cuda`，SenseVoice/Qwen 为 `cuda:0`；已清理 `.env` 中 FireRed、Whisper、SenseVoice 的旧 CPU 覆盖，设置迁移 v30 一次性迁移前端旧 CPU 默认。X-ASR CUDA 实测显存增加 1359 MiB。 |
| 2 | 离线/流式共存 | 通过 | Store 只保留 `offlineEngine` 与 `streamingEngine`；模型管理同时显示两个选择。 |
| 3 | 真实流式、删除伪流式 | 通过 | 真实 6.8 秒音频、512-frame 输入产生 23 partial、1 final，2.818 秒完成；单元测试断言未调用离线 `transcribe()` 且结束前补 1 秒静音。 |
| 4 | CapsWriter 风格热词 | 通过 | API E2E 保存 1 个热词和 1 条规则；`撒贝你...50赫兹` 转为 `撒贝宁...50Hz`。别名、黑名单、动态重载、无效正则均有测试。 |
| 5 | 录音排版 | 通过 | `.dock-player` 改为四列不换行 grid、去掉 360px 右边距并允许窄屏横向滚动；前端生产构建通过。 |
| 6 | 删除合并策略 | 通过 | 删除 `core/asr/router.py`、`merge_strategy`、`engine_results`、多引擎 Store/UI；离线接口只接受 `engine`。 |
| 7 | 本地/远程 TTS | 通过（协议） | 本地/Boson payload 测试、Boson URL、Bearer 转发和 Token 不进入 body 测试通过；无用户 Token，未调用真实 Boson 计费接口。 |
| 8 | 一一验证与报告 | 通过 | 本报告及下方命令、结果。 |
| 9 | 开发调试台 | 通过 | 前端统一 fetch 遥测 + ASR/TTS WS 指标，支持筛选、P95、清空和导出；TypeScript 与 Vite/Electron 构建通过。 |

## 自动化命令

```text
.venv/bin/pytest -q backend/tests/test_hotwords.py backend/tests/test_streaming_session.py backend/tests/test_engines.py backend/tests/test_x_asr.py backend/tests/test_higgs_remote.py
21 passed

node node_modules/typescript/bin/tsc --noEmit
通过

npm run build
Vite 75 modules transformed；Electron AppImage 构建通过

.venv/bin/python -m compileall -q backend/app
通过

UV_CACHE_DIR=/tmp/uv-cache uv lock --check
Resolved 246 packages
```

## API 与安全验证

- ASGI API：`/v1/health`、`/v1/hotwords`、`/v1/hotwords/preview`、`/v1/tts/higgs/connection` 均返回 200，并包含 `Server-Timing`。
- Boson 无 Token 连接检查返回 `connected=false` 和明确提示，不把 Token 放进 URL。
- 本地假远端服务器收到 `/v1/audio/speech`、`Authorization: Bearer secret-token` 和音频响应；请求 JSON 中不含 Token。

## X-ASR CUDA 实机验证

```text
runtime: 1.13.2+cuda12.cudnn9
provider: cuda
gpu_used_before_mib: 6142
gpu_used_after_load_mib: 7501
gpu_load_delta_mib: 1359
chunks: 213
partials: 23
finals: 1
elapsed_sec: 6.191
```

复现命令：

```bash
scripts/install_x_asr_cuda.sh
ASR_SAMPLE=/path/to/test.wav .venv/bin/python scripts/verify_x_asr_cuda.py
```

## 模型管理 AbortError 回归

- 根因：旧 `api.models()` 在 8 秒后执行无 reason 的 `controller.abort()`，Electron 直接显示 `signal is aborted without reason`；它不是 ASR 模型之间共享 signal。
- 修复：刷新 controller 归模型管理页面所有；新刷新替代旧刷新，替代/卸载取消静默处理；超时改为 20 秒并显示明确提示。
- 冲突保护：加载或卸载任一模型时禁用全部模型生命周期按钮，避免同时向 GPU 装载多个大模型。
- 后端并发读取：20 个并发 `GET /v1/models` 全部返回 200，总耗时 35.84 ms，最大服务端耗时 23.9 ms；返回的 X-ASR runtime 为 `1.13.2+cuda12.cudnn9`。
- TypeScript、Vite 和 Electron 构建通过；连续刷新取消只进入调试台 info，不进入页面错误栏。

## ASR 默认设备回归

全新后端进程读取 `.env` 并创建模型管理器，未加载模型时返回：

```text
fireredasr2  device=cuda
whisper      device=cuda compute_type=float16
sensevoice   device=cuda:0 configured_device=cuda:0
qwen3asr     device=cuda:0
x-asr        device=cuda runtime=1.13.2+cuda12.cudnn9
```

修改 `.env` 后需要重启后端进程；仅刷新模型管理页面不会重建后端的模型管理单例。

真实 Boson 合成仍需要用户自己的 API Token；本次没有代替用户发起远程计费请求。
