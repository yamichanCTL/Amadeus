# 修复实时 TTS 语义碎片与边界停顿计划

> **父文档**: [← 返回文档索引](../README.md)
> **相关文档**: [Higgs TTS 与变声器](../desktop/TTS_VOICE.md)

## 任务目标

- 禁止把 X-ASR 的不稳定单字 partial 直接变成可听语音。
- 只在稳定短语、自然标点或 final 边界提交 TTS，保证合成文本保持原句语义和韵律。
- 压缩独立 Higgs 请求产生的首尾静音，减少分段之间的异常停顿。
- 保留流式 PCM 首包播放，但质量优先于上一版的极限首字延迟。

## 影响范围

- `backend/app/api/v1/tts_api.py`：增量文本分段、final 对齐、PCM 边界静音处理。
- `backend/tests/test_higgs_tts_api.py`：语义完整性、分段规则和 PCM 输出测试。
- `scripts/benchmark_realtime_asr_tts.py`：记录实际提交给 TTS 的文本片段与间隔。
- `doc/desktop/TTS_VOICE.md`、`doc/CHANGELOG.md`、测试报告：质量/延迟取舍和验证结果。

## 实现步骤

1. partial 只使用连续两次 hypothesis 的 `stable_text`，不再用首个 unstable `text` 兜底。
2. 首段至少包含 6 个有效字符；优先在句号、问号、感叹号、分号等强边界提交，逗号只在短语足够长时提交，无标点时到安全上限才硬切。
3. final 必须从已提交的完整前缀后追加剩余文本；出现 hypothesis 修正时不按字符数量盲切，避免改变原句。
4. 对每个 Higgs PCM 流按 20 ms block 做在线静音门控，首段前导静音不输出，段尾只保留少量自然停顿。
5. 增加回归测试并用真实中文录音检查 TTS 片段不得是单字/纯标点，拼接文本必须等于 ASR final。
6. 更新文档、CHANGELOG 和测试报告。

## 风险评估

- 等待稳定短语会增加首音频延迟，短句通常需要等 final；这是避免语义错误的必要取舍。
- ASR 已经播出的内容无法撤回，因此任何 speculative partial 都必须保守；若 final 修正已提交前缀，本轮不补播错误片段。
- 在线静音门控需保留少量自然边界，过度裁剪会造成爆音或吞音。
- 工作区已有大量未提交改动，本次只修改上述直接相关文件。

## 执行结果

- 已撤销单字 unstable partial 兜底和按字符位置切 final 的行为。
- 已加入稳定自然短语分段和在线 PCM 边界静音门控。
- 已加入 900 ms 长尾静音提前关闭；自动化 PCM 流验证通过，最后一次宿主机复测受执行额度限制未运行。
- 真实短句只产生 `你好，世界` 一个 TTS 请求，拼接文本与 final 一致，播放 underrun 为 0 ms，裁剪边界静音 1040 ms。
- 首个有效 PCM 变为 2.870 秒；这是质量优先策略的预期延迟取舍。
