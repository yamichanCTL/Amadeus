# Runner TTS 引擎

> **父文档**: [← 返回 Runner 总览](README.md)

---

## 3 种 TTS 引擎

| 引擎 | 质量 | 延迟 | 说明 |
|------|------|------|------|
| **GPT-SoVITS** | 高 | 中 | 中文主力，少样本声音克隆 |
| **VoxCPM2** | 极高 | 高 | 2B 参数，48kHz，支持声音设计 |
| **MockTTS** | — | 即时 | 纯文本输出，无音频，开发兜底 |

## TTSProvider 接口

```python
class TTSProvider(ABC):
    name: str

    def synthesize(self, request: TTSRequest) -> TTSResult: ...

class TTSRequest:
    text: str
    voice: str            # 声音预设
    speed: float          # 语速
    output_path: str      # WAV 输出路径

class TTSResult:
    audio_path: str
    duration_seconds: float
    text: str
```

## GPT-SoVITS

- 通过 HTTP API 调用本机 `localhost:9880`
- 自动分句处理长文本
- 多句 WAV 拼接
- 依赖 `torchaudio` monkey-patch

## VoxCPM2

- 2B 参数高音质模型
- 支持 **声音设计**（文本描述音色）+ **声音克隆**（参考音频）
- 48kHz 采样率

## MockTTS

- 纯文本输出，无音频文件
- 用于开发调试和 CI
- TTS 不可用时的自动降级

## 语音风格选择

`tts/style.py` 定义 5 种 `SpeechStyle`：

| 风格 | 触发条件 | 说明 |
|------|----------|------|
| `success_summary` | Agent 执行成功 | 清晰、中速播报结果 |
| `error_brief` | Agent 失败 | 简洁错误提示 |
| `fallback_notice` | Agent 不可用 | 降级通知 |
| `progress_update` | 执行中 | 进行中状态反馈 |
| `greeting` | 会话开始 | 欢迎语 |

`VoiceSelector` 根据 Agent 执行结果自动选择风格。

---

> 📖 [编排器 →](ORCHESTRATOR.md) | [记忆系统 →](MEMORY.md)
