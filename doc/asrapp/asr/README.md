# ASR 系统总览

> **父文档**: [← 返回 asrapp 总览](../README.md)
> **子文档**:
> - [引擎对比](ENGINES.md) — 当前启用引擎横向评测
> - [伪流式识别](STREAMING.md) — VAD 驱动的离线模型伪流式方案

---

## 定位

ASR（Automatic Speech Recognition）是语音助手的**输入层**。当前启用 FireRedASR2、SenseVoice、Qwen3-ASR 和 Whisper，运行时热切换，单引擎或多引擎联合推理。

## 双 ASR 体系

系统有两套 ASR 实现：

| 体系 | 位置 | 说明 |
|------|------|------|
| **Backend ASR** | `backend/app/core/asr/` | 当前启用引擎实现，API 服务 |
| **Runner ASR** | `runner/asr/` | faster-whisper 单引擎，用于 demo |

## 核心抽象

```python
class ASREngine(ABC):
    name: str
    languages: list[str]

    def load(self) -> None: ...
    def unload(self) -> None: ...
    def transcribe(self, audio: bytes, **opts) -> ASRResult: ...

class ASRResult:
    text: str
    normalized_text: str
    language: str
    confidence: float
    segments: list[Segment]
    duration_sec: float
```

## 路由策略

| 策略 | 说明 |
|------|------|
| Single | 单引擎直接推理 |
| Multi-First | 多引擎并行，取第一个完成的结果 |
| Multi-Vote | 多引擎投票，选出现最多的文本 |
| Multi-Concat | 多引擎结果拼接 |

## VAD 伪流式

离线 ASR 引擎不支持真流式。通过 VAD 检测 + 分段 ASR 模拟实时体验：

```
麦克风 → VAD 检测语音 → 500ms 间隔 partial ASR → 静音触发 final ASR
```

---

> 📖 [引擎对比 →](ENGINES.md) | [伪流式设计 →](STREAMING.md)
