# ASR 系统总览

> **父文档**: [← 返回 asrapp 总览](../README.md)
> **子文档**:
> - [引擎对比](ENGINES.md) — 当前启用引擎横向评测
> - [流式识别](STREAMING.md) — X-ASR 原生流式会话
> - [X-ASR 接入](X_ASR.md) — 模型文件、配置、运行与验证
> - [离线识别热词](HOTWORDS.md) — CapsWriter 风格热词与规则

---

## 定位

ASR（Automatic Speech Recognition）是语音助手的**输入层**。当前启用 X-ASR、FireRedASR2、SenseVoice、Qwen3-ASR 和 Whisper。离线和实时通路同时配置：完整音频由一个离线模型处理，实时音频只由 X-ASR 原生流式模型处理。

## 双 ASR 体系

系统有两套 ASR 实现：

| 体系 | 位置 | 说明 |
|------|------|------|
| **Backend ASR** | `backend/app/core/asr/` | 当前启用引擎实现，API 服务 |
| **Runner ASR** | `runner/asr/` | faster-whisper 单引擎，用于 demo |

## 核心抽象

```python
class BaseASREngine(ABC):
    name: str
    languages: list[str]

    def load(self) -> None: ...
    def unload(self) -> None: ...
    def transcribe(self, audio: bytes, **opts) -> ASRResult: ...
    def create_streaming_session(self, sample_rate, opts) -> BaseStreamingASRSession: ...

class ASRResult:
    text: str
    normalized_text: str
    language: str
    confidence: float
    segments: list[Segment]
    duration_sec: float
```

## 模型选择

模型管理中的 `离线识别模型` 与 `实时流式模型` 相互独立，不存在工作模式切换或多模型合并策略。离线请求始终单引擎直接推理。

## 真流式

X-ASR 保留 Zipformer online decoder 状态，PCM 块到达后立即增量解码。VAD 只负责确定话语边界；partial 和 final 始终来自同一个 X-ASR stream：

```
麦克风 → VAD speech_start → X-ASR PCM 增量 partial
       → VAD speech_end → 补尾静音 → X-ASR final
```

---

> 📖 [引擎对比 →](ENGINES.md) | [流式设计 →](STREAMING.md) | [X-ASR 接入 →](X_ASR.md) | [热词 →](HOTWORDS.md)
