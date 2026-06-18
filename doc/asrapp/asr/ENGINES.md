# ASR 引擎横向对比

> **父文档**: [← 返回 ASR 总览](README.md)

---

## 当前启用引擎一览

| 引擎 | 类型 | 语言 | 精度 | 速度 | 显存 | 离线 |
|------|------|------|------|------|------|------|
| **FireRedASR2** | AED | 中英 | ★★★★★ | ★★★★ | 高 | ✅ |
| **SenseVoice** | CTC+AED | 中英日韩粤 | ★★★★★ | ★★★★ | 中 | ✅ |
| **Qwen3-ASR** | AED | 中英 | ★★★★★ | ★★★ | 高 | ✅ |
| **Whisper** (faster) | Enc-Dec | 99语种 | ★★★★ | ★★★ | 低 | ✅ |

## 引擎详情

### FireRedASR2（主力）
- 类型：AED（Attention Encoder-Decoder）
- 主力中文引擎，高精度
- 支持 CUDA/CPU
- 模型目录需要：`model.pth.tar`、`cmvn.ark`、`dict.txt`

### SenseVoice
- 类型：CTC + AED 联合建模
- 多语言（中英日韩粤）+ 情绪识别
- 适合多语种场景
- 伪流式中用于 partial 快速推理

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
| 中文高精度 | FireRedASR2（主力）+ SenseVoice（辅助） |
| 多语种 | SenseVoice / Whisper |
| 低资源设备 | Whisper base / SenseVoice CPU |
| 实时字幕 | SenseVoice small（快速 partial）+ FireRedASR2（final） |
| 通用英文 | Whisper |

## 协同推理

流式场景推荐组合：

```
VAD 检测语音 →
  SenseVoice Small partial（每 500ms，快速）
  → 静音结束 →
  FireRedASR2 final（完整语音段，高精度）
  → final 替换 partial
```

---

> 📖 [伪流式设计 →](STREAMING.md) | [引擎管理 API →](../backend/ENGINES.md)
