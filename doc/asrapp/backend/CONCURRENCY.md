# Backend 并发推理方案

> **父文档**: [← 返回 Backend 总览](README.md)
> **子文档**: 无

## 目标

- 一个后端实例支撑 10 人以上同时使用。
- 模型不要按用户数重复加载，避免显存线性增长。
- 长音频和短音频统一进入模型准入队列，短任务新增等待控制在 100 ms 内。
- 支持未来按引擎能力打开 micro-batch，而不是盲目提高 Celery worker 进程数。

## 推荐架构

```
HTTP / WebSocket
  -> FastAPI 接入层
  -> DB task 状态
  -> Celery / in-process dispatch
  -> 每 GPU 一个模型执行器
  -> 100 ms micro-batch queue
  -> ASR engine.transcribe_batch / transcribe
```

当前代码已落地 `InferenceScheduler`：

- 所有离线 ASR 请求统一调用 `transcribe_with_scheduler()`；
- 每个 engine name 复用一个执行器队列；
- 模型空闲时首个请求立即执行，不额外等待；
- 模型忙碌期间排队的请求会在最多 100 ms 内聚合成 micro-batch；
- 长音频 Celery task 会按 `ASR_LONG_AUDIO_CHUNK_SEC` 切成多个 WAV chunk，逐段进入同一个 scheduler，避免整段长音频独占模型；
- 调度器指标可通过 `GET /v1/models/scheduler` 查看。

## 关键规则

1. **不要用 Celery 高并发直接跑 GPU 推理**

   `--concurrency=8` 会让 8 个 worker 进程分别加载模型，显存会被复制 8 份。GPU ASR worker 默认仍建议 `--concurrency=1`，多 GPU 才按 GPU 数启动多个 worker。

2. **模型层做准入队列**

   每个引擎维护一个队列，队列项包含音频路径或 bytes、EngineOptions、deadline 和 Future。执行器按以下条件 flush：

   - 等待时间达到 100 ms；
   - batch 数达到引擎配置上限；
   - 总音频秒数达到显存预算；
   - 队首任务是超长任务且需要独占执行。

3. **优先按总音频秒数限制 batch**

   FireRedASR2 已接入原生 batch adapter，会把同一 micro-batch 的多条音频一次传给上游 `transcribe(uttids, audios)`。SenseVoice、Whisper、Qwen3-ASR、X-ASR 当前通过默认 `transcribe_batch()` 逐条兼容执行，但仍受统一队列保护，不会并发打入同一个模型实例。后续给这些引擎接原生 batch 时，不需要改变 API 调用路径。

4. **长音频拆段后再排队**

   对长音频不再整段占用模型。当前 Celery task 按固定窗口拆成 WAV chunk，默认 `ASR_LONG_AUDIO_CHUNK_SEC=60`；每个 chunk 逐段进入同一执行器队列，最后按 chunk 起始时间偏移合并 segment。后续真实 VAD 接好后，可把 VAD segment 复用到同一队列。

5. **短任务优先级高于长任务片段**

   交互式录音和短文件延迟敏感，应设置较高优先级。长音频拆片后按片段排队，避免一个长任务阻塞后续 10 个短任务。

## 配置建议

| 项 | 建议值 | 说明 |
|----|--------|------|
| API worker | 1 到 2 | FastAPI 主要做 IO，模型不在 API worker 里复制加载 |
| Celery GPU worker | 每 GPU 1 个进程 | 防止模型重复占用显存 |
| `worker_prefetch_multiplier` | 1 | 防止单 worker 预取太多长任务 |
| micro-batch 等待 | 50 到 100 ms | 用户要求新增延迟不超过 100 ms 时，上限取 100 ms |
| batch 限制 | `ASR_INFERENCE_MAX_BATCH_ITEMS=4` | 当前按条数限制；后续可增加 `max_batch_audio_sec` |
| 长音频片段 | `ASR_LONG_AUDIO_CHUNK_SEC=60` | 根据模型吞吐和显存压测调整，建议 20 到 60 秒 |

## 落地步骤

1. 已完成：给 `BaseASREngine` 增加可选 `transcribe_batch(items)`，默认逐条执行以保持兼容。
2. 已完成：在 `model_manager` 上层增加 `InferenceScheduler`，按 engine name 复用执行器。
3. 已完成：短音频同步接口、长音频 Celery task、Higgs reference ASR、音频转 Higgs TTS 都通过 scheduler。
4. 已完成：增加 `GET /v1/models/scheduler` 指标：submitted、completed、failed、batches、max batch、queue wait。
5. 已完成：FireRedASR2 原生 batch adapter。
6. 已完成：长音频 Celery task 固定窗口拆段，逐 chunk 进入 scheduler，并按时间偏移合并结果。
7. 待真实环境压测：用 10 到 20 并发、真实模型和 GPU 显存监控确认 P50/P95 延迟、吞吐和显存峰值，再逐步放大 batch。

## 当前变更

本次实现了代码级并发调度器，并保留上一轮长音频 Celery result backend 修复：ASR task 的最终状态写入数据库，客户端轮询 `/v1/tasks/{task_id}`，Celery 不再写 result backend。当前测试覆盖所有注册离线模型名的调度路径：`fireredasr2`、`sensevoice`、`whisper`、`qwen3asr`、`x-asr`、`mock`；长音频拆段测试覆盖 chunk WAV 生成、逐段 scheduler 调用和 segment 时间偏移合并。真实 GPU/真实模型压测仍需在模型文件和显存可用的部署环境执行。
