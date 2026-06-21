# 2026-06-19 TTS 参考文本预填充改用通用 ASR 计划

## 目标

修复 `模型管理 -> TTS 模型设置 -> 当前 ASR 生成并填充` 仍出现 `Failed to fetch` 的问题。参考音频文本预填充不再走独立 `/v1/tts/higgs/reference-asr`，而是直接复用桌面端已有转写接口 `/v1/transcribe`。

## 影响范围

- `frontend/desktop/src/pages/Models.tsx`
- `doc/desktop/TTS_VOICE.md`
- `doc/CHANGELOG.md`

## 实现步骤

1. 在 `Models.tsx` 引入 `isAsyncResponse` 和 `TranscribeOptions`。
2. 为参考音频构造最小转写参数：当前 ASR 引擎、当前语言、标点/说话人/合并策略等现有设置。
3. `generateReferenceText()` 将参考音频 Data URL 转成 Blob 后调用 `api.transcribe()`。
4. 如果返回异步任务，使用 `api.task()` 轮询到终态，复用现有转写流程。
5. 将 `full_text` trim 后直接写入 `higgsTtsReferenceText`。
6. 更新文档和 CHANGELOG。
7. 运行前端类型检查和构建。

## 风险评估

- `/v1/transcribe` 可能根据音频长度返回同步或异步结果，必须覆盖两种返回形态。
- 参考音频通常很短，默认超时可沿用 `settings.timeoutSec`；若设置为 0，则给足 30 分钟上限。
- 该改动只影响 TTS 模型页的预填充按钮，不改后端已有接口。
