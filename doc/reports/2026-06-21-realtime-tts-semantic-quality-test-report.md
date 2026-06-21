# 2026-06-21 实时 TTS 语义与连续性测试报告

> **父文档**: [← 返回 Higgs TTS 与变声器](../desktop/TTS_VOICE.md)
> **相关计划**: [修复实时 TTS 语义碎片](../plans/2026-06-21-fix-realtime-tts-semantic-fragmentation.md)

## 根因

上一版把 X-ASR 第一个 unstable partial 立即提交给 Higgs，并按已播字符数量切 final 后缀。真实结果会形成 `你 / 好， / 世界` 这类独立请求：每段语义上下文、声调和韵律都不同，Higgs 请求之间还会叠加首尾静音，因此听感表现为异常截断、停顿和语义改变。

## 修复后的规则

- partial 只读取 X-ASR `stable_text`，禁止 unstable 文本兜底。
- 首段至少 6 个有效字符，后续至少 8 个有效字符，并且必须处于自然标点或安全空格边界；无边界中文等待 final。
- final 必须以已提交文本为完整前缀，否则不再按字符位置盲切后缀。
- PCM 以 20 ms block 在线处理：删除前导静音，内部静音最多保留 160 ms，段尾保留 40 ms；有效语音后连续静音达到 900 ms 时关闭上游流。

## 真实链路结果

测试环境：X-ASR `chunk-160ms-model` CUDA、Higgs Audio v3 Elysia、32 ms PCM 输入块、8000→8002 实际服务。

| 输入 | TTS 请求片段 | 与 final 一致 | 微片段 | 播放 underrun | 边界静音裁剪 |
|---|---|---:|---:|---:|---:|
| 2.32 秒 `hello_zh.wav` | `你好，世界` | 是 | 0 | 0 ms | 1040 ms |
| 5.62 秒 `zh.mp3` | `开放时间早上九点至下午五点` | 是 | 0 | 未观察到分段 | 在线门控启用 |

短句质量优先结果：VAD `0.101s`、首 partial `1.110s`、final 后完整 TTS 启动 `2.193s`、首个有效 PCM `2.870s`。首包比激进单字模式慢，但 TTS 输入不再改变原句语义。

## 自动化验证

- `29 passed`：Higgs TTS、流式 session、X-ASR 目标测试。
- 覆盖 unstable partial 不触发、稳定标点短语触发、所有片段拼接等于 final、final 修正时不做位置切片。
- 覆盖前导/尾部静音裁剪、自然边界保留和 `trimmed_silence_ms`。
- 900 ms 尾静音提前关闭已由可控 PCM 流自动化验证；加入该逻辑后的最后一次宿主机真实复测因执行额度限制未运行，未将其写成真实通过。
- `scripts/benchmark_realtime_asr_tts.py` 同时检查 `semantic_text_match`、`no_micro_fragments`、播放 buffer underrun 和裁剪静音量。
