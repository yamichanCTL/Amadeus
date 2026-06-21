# ASR 引擎横向对比

> **父文档**: [← 返回 ASR 总览](README.md)

---

## 当前启用引擎一览

| 引擎 | 类型 | 语言 | 精度 | 速度 | 显存 | 离线 |
|------|------|------|------|------|------|------|
| **X-ASR** | Streaming Transducer | 中英 | ★★★★★ | ★★★★★ | CPU 可用 | ✅ |
| **FireRedASR2** | AED | 中英 | ★★★★★ | ★★★★ | 高 | ✅ |
| **SenseVoice** | CTC+AED | 中英日韩粤 | ★★★★★ | ★★★★ | 中 | ✅ |
| **Qwen3-ASR** | AED | 中英 | ★★★★★ | ★★★ | 高 | ✅ |
| **Whisper** (faster) | Enc-Dec | 99语种 | ★★★★ | ★★★ | 低 | ✅ |

## 引擎详情

### X-ASR（真流式）
- 160 / 480 / 960 / 1920 ms Zipformer transducer，sherpa-onnx online runtime
- 每句话持有独立 decoder stream，PCM 块到达即产生 partial
- 默认 CUDA provider；CPU-only wheel 会明确提示并回退 CPU
- 模型位于 `thirdparty/X-ASR/X-ASR-zh-en/deployment/models/chunk-<窗口>ms-model/`
- 可复用同一 stream 产生 final，避免整句重复推理

### FireRedASR2（主力）
- 类型：AED（Attention Encoder-Decoder）
- 主力中文引擎，高精度
- 支持 CUDA/CPU
- 模型目录需要：`model.pth.tar`、`cmvn.ark`、`dict.txt`

### SenseVoice
- 类型：CTC + AED 联合建模
- 多语言（中英日韩粤）+ 情绪识别
- 适合多语种场景
- 用作完整音频的离线识别模型

### Qwen3-ASR
- 类型：AED
- 通义千问系列 ASR 模型
- 中文识别精度接近 FireRedASR2

### Whisper (faster-whisper)
- 类型：Encoder-Decoder Transformer
- CTranslate2 加速推理
- 99 种语言，通用性最强
- 模型大小：tiny / base / small / medium / large-v3

## 引擎选择建议

| 场景 | 推荐引擎 |
|------|----------|
| 实时语音 / 字幕 | X-ASR（默认 160 ms，可切换四种窗口） |
| 文件/录音中文高精度 | FireRedASR2 或 SenseVoice |
| 多语种 | SenseVoice / Whisper |
| 低资源设备 | Whisper base / SenseVoice（手动切换 CPU） |
| 实时字幕 | X-ASR 多窗口 |
| 通用英文 | Whisper |

## 双通路

实时音频只使用 X-ASR online decoder；文件、普通录音和参考音频只使用当前离线模型。两条通路共享语言等基础设置，但不会在一句话中混用或合并结果。

---

> 📖 [流式设计 →](STREAMING.md) | [X-ASR 接入 →](X_ASR.md) | [引擎管理 API →](../backend/ENGINES.md)
