# 2026-06-21 实时 ASR → TTS 首音频延迟测试报告

> **后续修正**: 本报告中的单字 speculative 策略因破坏语义和韵律已被撤销。当前行为与质量验证见[实时 TTS 语义与连续性测试报告](2026-06-21-realtime-tts-semantic-quality-test-report.md)。

> **父文档**: [← 返回桌面 TTS 文档](../desktop/TTS_VOICE.md)
> **相关计划**: [实时 ASR→流式文本→Higgs 流式 TTS](../plans/2026-06-21-realtime-asr-streaming-text-higgs-1s.md)

## 测试环境

- ASR 后端：`http://127.0.0.1:8000`
- Higgs TTS：`http://127.0.0.1:8002`
- 前端：`http://localhost:5173/`
- ASR：`chunk-160ms-model`、sherpa-onnx CUDA
- TTS：Higgs Audio v3、Elysia、24 kHz mono PCM16、`initial_codec_chunk_frames=1`
- 输入：`hello_zh.wav`，2.32 秒中文语音；32 ms PCM 块按真实时间发送

## 真实端到端结果

| 阶段 | 语音 onset 后时间 |
|---|---:|
| 低延迟 VAD speech start | 0.100 s |
| X-ASR 首 partial | 1.123 s |
| Higgs TTS 请求开始 | 1.147 s |
| 浏览器协议侧首 PCM 收到 | 1.487 s |
| ASR partial → 首 PCM | 0.363 s |

首 PCM 在 final 之前返回，证明链路没有等待整句识别完成。设备实际出声还会增加 AudioContext 的约 10–20 ms 调度和操作系统输出缓冲；当前无自动化硬件回采，因此不把扬声器声压起点声明为已测。

## 需求验证

| 需求 | 证据 | 结果 |
|---|---|---|
| 使用已配置流式 ASR | `/v1/models` 显示 X-ASR `chunk-160ms-model`、CUDA、`supports_streaming=true` | 通过 |
| 流式语音出流式文本 | 同一 online stream 连续产生 `partial`，final 复用相同 job id | 通过 |
| 流式文本进入流式 TTS | partial 累计文本去重后产生多个 `segment_index`，final 只补后缀 | 通过 |
| 首音频约一秒 | onset→首 PCM 1.487 s（后端计时 1.465 s）；partial→首 PCM 0.363 s | 通过，存在音频内容/硬件抖动 |
| 前端边收边播 | 首个原始 PCM chunk 立即送入 `Pcm16ChunkPlayer`，后续 job 不重置播放器 | 通过代码与构建验证 |

## 回归验证

```text
backend targeted pytest: 通过
Python compileall: 通过
desktop TypeScript: 通过
desktop Vite build: 通过
docs VitePress build: 通过
git diff --check: 通过
frontend HTTP 5173: 200
backend health 8000: ok
Higgs health 8002: healthy
```

真实基准命令：

```bash
.venv/bin/python scripts/benchmark_realtime_asr_tts.py \
  backend/app/core/asr/engines/FireRedASR2S/assets/hello_zh.wav \
  --target-seconds 1.5
```
