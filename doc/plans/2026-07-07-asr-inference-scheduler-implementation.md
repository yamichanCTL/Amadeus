# 2026-07-07 ASR 并发推理调度器实现

## 任务目标

- 将并发方案从文档落到后端代码：所有离线 ASR 模型经过统一 `InferenceScheduler` 准入队列。
- 控制短任务新增等待不超过 100 ms；模型空闲且无排队时不额外等待。
- 防止同一模型实例被多个请求同时打爆 GPU；默认每个 engine 一个执行器顺序执行，配置允许未来按模型能力扩展 batch。
- 为所有已注册离线模型覆盖调度路径：`fireredasr2`、`sensevoice`、`whisper`、`qwen3asr`、`x-asr`、`mock`。
- 为同步短音频与 Celery 长音频路径同时接入调度器。

## 影响范围分析

- `backend/app/core/asr/base.py`：增加可选 `transcribe_batch` 默认实现，统一 future batch 接口。
- `backend/app/core/inference_scheduler.py`：新增调度器、队列、微批 flush、指标快照。
- `backend/app/config.py`：新增调度器配置项。
- `backend/app/api/v1/transcribe.py`、`backend/app/tasks/asr_task.py`、`backend/app/api/v1/tts_api.py`：离线 ASR 调用改用调度器。
- `backend/app/core/model_manager.py`：关停时一并停止调度器。
- `backend/tests/`：新增调度器和全模型路径单元测试。
- `doc/asrapp/backend/CONCURRENCY.md`、`doc/CHANGELOG.md`：同步实现状态与验证结果。

## 实现步骤

1. 增加 `BaseASREngine.transcribe_batch()`，默认逐条调用 `transcribe()`，保持所有模型兼容。
2. 新增 `InferenceScheduler`，按 engine name 建立执行器；队列空闲时立即执行第一条，排队场景最多等待配置的 100 ms 形成 micro-batch。
3. 在短音频 API、长音频 Celery task 和音频转 TTS 的 ASR 调用点接入 `transcribe_with_scheduler()`。
4. 暴露调度器指标：提交数、完成数、失败数、batch 数、最大 batch、平均/最大排队等待。
5. 编写 mock engine 并发测试，覆盖所有 registered engine name 的配置路径和单 engine 串行保护。
6. 运行后端定向测试、Python 编译、必要的前端类型/构建回归。

## 风险评估

- 真实模型 batch 能力差异大，本次先实现统一调度和逐条兼容 batch，不强行让所有引擎走原生 batch。
- 在单进程内调度器有效；多进程 Celery 仍会各自拥有模型实例，因此部署层仍必须保持每 GPU 单 worker。
- 100 ms 聚合只对已有排队请求生效；模型空闲时立即执行，避免单请求平白增加延迟。
- 真实 GPU/所有模型端到端验证依赖本机模型文件和显存；如环境无法加载某模型，本次会用接口级覆盖和配置检查说明边界。
