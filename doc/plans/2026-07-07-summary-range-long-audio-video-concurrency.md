# 2026-07-07 总结范围、长音频、视频上传与并发方案

## 任务目标

- 将桌面日志总结从单日 `date` 扩展为可选择开始日期和结束日期，支持例如 2026-07-01 到 2026-07-05 的范围总结。
- 修复长音频 Celery 任务在写 result backend 时断连导致的 `Retry limit exceeded while trying to reconnect to the Celery result store backend`。
- 减少视频上传浪费：桌面端在上传本地视频前先提取音轨，只上传音频。
- 给出后端多用户并发推理方案，兼顾 batch、排队、进程数和显存。

## 影响范围分析

- `backend/app/schemas/llm.py`：扩展总结请求/返回的日期范围字段。
- `backend/app/core/archive.py`：归档记录支持跨日期遍历和按时间范围过滤。
- `backend/app/core/llm.py`：总结 transcript、prompt 和 meta 支持日期范围显示。
- `frontend/desktop/src/pages/Summary.tsx`、`frontend/desktop/src/services/summaryRecords.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/services/api.ts`：桌面总结 UI、状态和本机记录过滤支持日期范围。
- `backend/app/tasks/celery_app.py`、`backend/app/tasks/asr_task.py`：长音频 Celery 任务忽略 result backend，状态以数据库为准。
- `frontend/desktop/electron/main.ts`、`preload.ts`、`vite-env.d.ts`、`DropZone.tsx`：视频文件上传前抽音频。
- `doc/asrapp/backend/CONCURRENCY.md`：并发方案。

## 实现步骤

1. 后端 schemas、归档遍历和 LLM summary 管线增加 `start_date`/`end_date`，保持旧 `date` 字段兼容。
2. 桌面总结页增加结束日期输入，默认当天到当天；本机记录和服务端归档都按日期范围过滤。
3. Celery ASR 任务设置 `ignore_result=True`，全局关闭结果存储依赖；API 继续通过 DB task 状态轮询。
4. Electron 主进程新增 `media:extractAudioForUpload`，对视频扩展名用 `ffmpeg` 抽取 16k mono WAV；缺少 ffmpeg 或抽取失败时返回明确错误。
5. 编写/更新目标测试，覆盖日期范围过滤、跨日服务端 transcript、Celery ignore result 配置和视频抽音频命令。
6. 更新并发设计文档、CHANGELOG 和相关项目文档。

## 风险评估

- 日期范围如果与时间段组合，跨多日时应解释为每天的开始/结束时间窗口，而不是只取首尾两天的绝对时间。
- 视频抽音频依赖 `ffmpeg` 可执行文件；本项目后端解码视频/容器格式本来也依赖 ffmpeg，但桌面端需要能在主进程 PATH 中找到它。
- 真正的模型 batch 并发不能只改 Celery 并发数；需要每 GPU 单模型进程 + 微批聚合，否则多进程会重复加载模型导致显存浪费。
- 本次不直接上线大规模动态 batching，而是给出可实施方案并修复当前长音频队列稳定性。
