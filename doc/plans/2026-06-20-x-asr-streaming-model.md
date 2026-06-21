# X-ASR 真流式模型接入计划

> **父文档**: [← 返回文档索引](../README.md)
> **相关文档**:
> - [ASR 系统总览](../asrapp/asr/README.md)
> - [流式 ASR 设计](../asrapp/asr/STREAMING.md)
> - [ASR 引擎对比](../asrapp/asr/ENGINES.md)

## 任务目标

- 将 `thirdparty/X-ASR` 的 X-ASR-zh-en 160 ms ONNX 模型注册为 `x-asr` 引擎。
- 在 `/v1/stream` 中保持每句话独立的 sherpa-onnx online stream，持续接收 PCM 块并返回真实 partial/final，而不是重复跑整句离线推理。
- 保留离线 ASR 路径，并允许流式 X-ASR 的 final 直接使用同一 online stream，或选择已有离线模型做最终精修。
- 在桌面模型管理界面增加“离线模型 / 流式模型”模式、流式引擎与最终模型选择，并把选择应用到实时 ASR、实时 ASR+TTS。
- 下载运行所需的 160 ms 模型文件，完成单元、API、前端构建及真实模型流式推理验证。

## 影响范围

- 后端引擎：`backend/app/core/asr/base.py`、`engines/x_asr.py`、`registry.py`、`model_manager.py`、`config.py`。
- 流式会话：`backend/app/core/streaming/session.py` 及对应测试。
- 模型 API/schema：`backend/app/api/v1/models.py`、`backend/app/schemas/transcribe.py`。
- 桌面配置/UI：`frontend/desktop/src/store/useASRStore.ts`、`pages/Models.tsx`、实时语音调用点及模型选择组件。
- 依赖与模型：`pyproject.toml`、`thirdparty/X-ASR/.../chunk-160ms-model/`。
- 文档：ASR 模块文档、`doc/CHANGELOG.md`。

## 实现步骤

1. 扩展 ASR 基类的能力元数据与流式会话协议，注册并配置 `x-asr`。
2. 封装 X-ASR sherpa-onnx online recognizer：模型加载一次、每个用户话语创建独立 stream、增量解码、输入结束刷新 final；同时支持上传音频的单次转写兼容路径。
3. 改造 `StreamingASRSession`：X-ASR 模式直接喂入实时 PCM；VAD 只负责话语边界，final 可复用流式结果或调用选定离线精修引擎。
4. 扩展模型管理 API 的加载参数与模型能力展示。
5. 增加桌面端持久化设置 `asrMode`、`streamingEngine`、`streamingFinalEngine`；在模型管理页展示模式选择和模型能力，并接入实时客户端。
6. 补充流式引擎、会话、API 和设置迁移测试；下载 160 ms ONNX 文件并运行真实 PCM 分块测试。
7. 更新 ASR 文档、侧边栏文字和 CHANGELOG，运行后端、TypeScript、Vite、文档构建验证。

## 风险评估

- `sherpa-onnx` 与 Python 3.13/本机 CUDA 的兼容性可能有限：优先使用 CPU wheel 验证，CUDA 作为可配置选项。
- ONNX 文件体积较大且由 Git LFS 管理：只拉取 160 ms 运行集，避免无必要下载全部约 2.4 GB 模型。
- 当前工作区存在未提交且重叠的模型管理、流式、TTS 修改：仅做增量补丁，不回滚现有内容；验证时区分既有失败与本次回归。
- 同一个 online recognizer 可共享模型，但 stream 状态不可共享：实现必须让每个话语/连接拥有独立状态，并避免卸载与在途识别竞态。
- 流式 final 与离线精修 final 的语义不同：UI 明确提供“同流式模型最终输出”和“离线模型精修”两种选择。

## 执行结果

- 已实现 `x-asr` 引擎、能力元数据、模型管理热加载和同一 online stream 的 partial/final。
- 已新增桌面端 `asrMode`、`streamingEngine`、`streamingFinalEngine` 持久化设置，并接入实时 ASR+TTS。
- 已安装 `sherpa-onnx 1.12.39`，下载 160 ms 三个 ONNX 文件并通过上游 SHA-256 校验。
- 18 个 X-ASR/流式/引擎定向测试通过；TypeScript、Vite、Python compileall 通过。
- 真实 6.8 秒中文录音在 CPU 上产生 21 个 partial，2.518 秒产出 final。
- FastAPI `ASGITransport` HTTP 包装层测试因本仓库既有 TestClient/ASGITransport 挂起问题未作为证明；改用模型 API 函数级 list/load/unload 验证并通过。桌面端 TypeScript、Vite 与 electron-builder 完整 AppImage 打包通过。
