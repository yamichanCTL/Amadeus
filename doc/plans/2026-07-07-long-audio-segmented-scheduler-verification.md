# 2026-07-07 长音频拆段调度与并发验证补强

## 任务目标

- 补齐并发方案里“长音频拆段后再排队”的代码实现，避免长音频整段独占同一个 ASR 模型执行器。
- 长音频 Celery task 仍复用统一 `InferenceScheduler`，每个片段作为独立请求进入模型队列，让短任务有机会穿插排队。
- 合并分段识别结果时保持文本顺序、segment 时间偏移、语言、置信度和 raw 调试信息。
- 为拆段逻辑和调度入口补充无需真实模型的自动化验证。

## 影响范围分析

- `backend/app/tasks/asr_task.py`：新增音频 decode、固定窗口拆段、chunk WAV 编码、分段 ASR 调用和结果合并。
- `backend/app/config.py` / `backend/.env.example`：新增长音频分段窗口配置。
- `backend/tests/`：新增长音频分段与合并单元测试。
- `doc/asrapp/backend/CONCURRENCY.md`、`doc/CHANGELOG.md`：同步实现状态、配置和验证边界。

## 实现步骤

1. 新增纯函数：解码音频、按秒数切分、编码 WAV chunk、合并 `ASRResult`。
2. Celery 长音频 task 中，当音频时长超过分段窗口时按 chunk 顺序逐段调用 `transcribe_with_scheduler()`。
3. 给 timing/raw 标记 chunk 数、chunk 秒数和 scheduler 状态，便于压测时定位。
4. 编写测试覆盖 chunk 切分长度、segment 时间偏移、文本拼接和调度调用次数。
5. 跑后端定向回归、Python 编译、文档构建和 diff check。

## 风险评估

- 当前按固定窗口拆段，不依赖真实 VAD；未来 VAD 接好后可把 VAD segment 转为同一 chunk 队列。
- 分段会让同一个长任务有多次 scheduler 调用，整体吞吐取决于模型和 GPU；需要真实环境压测确认最佳窗口。
- 不在本轮引入新依赖，避免改变部署环境。
