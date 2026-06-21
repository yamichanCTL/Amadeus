# X-ASR 真流式模型接入

> **父文档**: [← 返回 ASR 总览](README.md)
> **相关文档**:
> - [流式会话设计](STREAMING.md)
> - [引擎对比](ENGINES.md)

## 运行结构

`x-asr` 封装上游 X-ASR-zh-en 的 160 / 480 / 960 / 1920 ms Zipformer ONNX 模型。当前只加载用户选中的一套权重，所有会话共享该 OnlineRecognizer；每个话语通过 `create_streaming_session()` 创建独立 sherpa-onnx stream：

```
ModelManager
└── XASREngine（共享 OnlineRecognizer / ONNX 权重）
    ├── utterance stream A（独立 encoder/decoder 状态）
    └── utterance stream B（独立 encoder/decoder 状态）
```

`StreamingASRSession` 收到 VAD `speech_start` 后创建 stream，将 pre-roll 和后续 16 kHz、mono、signed int16 PCM 持续送入。`speech_end` 调用 `input_finished()`，并刷新剩余 decoder 输出。

## 模型文件

模型目录：

```text
thirdparty/X-ASR/X-ASR-zh-en/deployment/models/
├── chunk-160ms-model/
├── chunk-480ms-model/
├── chunk-960ms-model/
└── chunk-1920ms-model/
```

每个目录必须使用同一窗口的 encoder、decoder、joiner 和 tokens，不能跨目录混用。权重来自 Hugging Face `GilgameshWind/X-ASR-zh-en`：

```bash
hf download GilgameshWind/X-ASR-zh-en \
  --include 'deployment/models/chunk-*-model/*' \
  --local-dir thirdparty/X-ASR/X-ASR-zh-en
```

## 安装与配置

安装 runtime：

```bash
uv pip install --python .venv/bin/python 'sherpa-onnx>=1.10.0'
```

后端环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEFAULT_X_ASR_MODEL` | `chunk-160ms-model` | 模型显示名 |
| `X_ASR_MODEL_DIR` | thirdparty 下 160 ms 目录 | 模型绝对或相对路径 |
| `DEFAULT_X_ASR_PROVIDER` | `cuda` | `cpu` 或 `cuda` |
| `X_ASR_NUM_THREADS` | `1` | CPU 推理线程数 |
| `X_ASR_TEXT_FORMAT` | `none` | `none` / `lower` / `capitalize` |
| `X_ASR_CUDA_LIBRARY_PATH` | 空 | NVIDIA CUDA 12 / cuDNN 9 动态库根目录 |

本机 CUDA 安装和实机验证命令见[模型管理稳定性与 CUDA](../../desktop/MODEL_MANAGEMENT.md)。请求 `cuda` 时如果安装的是 CPU-only sherpa wheel，加载会直接失败，避免 ONNX Runtime 静默回退 CPU。

## 桌面端选择

进入 `模型管理 → ASR 模型设置`：

1. “实时流式模型”选择 `X-ASR`。
2. 独立选择文件/录音使用的“离线识别模型”。
3. 展开 X-ASR 模型卡，勾选 160 / 480 / 960 / 1920 ms 窗口；页面同时显示本地下载状态。
4. 选择 CUDA、线程数等参数并点击“加载”，后端热切换到所选窗口。

窗口越小，首个 partial 更快；窗口越大，官方基准准确率通常更高，但算法等待更长。默认仍为 160 ms。

设置保存在桌面端 Zustand 持久化存储中，实时字幕、免按键对话和实时 ASR+TTS 都使用 `streamingEngine`。

## API 能力

`GET /v1/models` 的 X-ASR 条目在 `extra` 中包含：

```json
{
  "supports_streaming": true,
  "model_modes": ["streaming"],
  "model_available": true,
  "chunk_ms": 160,
  "model_variants": ["chunk-160ms-model", "chunk-480ms-model", "chunk-960ms-model", "chunk-1920ms-model"],
  "available_variants": ["chunk-160ms-model", "chunk-480ms-model", "chunk-960ms-model", "chunk-1920ms-model"],
  "runtime": "sherpa-onnx"
}
```

加载示例：

```json
POST /v1/models/x-asr/load
{
  "model_name": "chunk-160ms-model",
  "device": "cpu",
  "extra": {"num_threads": 1, "text_format": "none"}
}
```

实时入口为 `WS /v1/stream`。配置帧只需设置 `engine=x-asr`，partial 和 final 复用同一个 online stream；服务端不再接受离线精修模型，也不会分块反复调用离线 ASR。

实时会话按官方 live demo 的关键顺序执行：512 帧 PCM 输入、700 ms 预卷、VAD 上升沿创建 decoder stream、持续增量 decode、VAD 下降沿补 1 秒静音后 `input_finished()` 并输出 final。

## 已验证基线

- 四套目录均已从 Hugging Face 下载完整 ONNX 文件，不是 Git LFS pointer。
- 单元测试覆盖四种窗口的文件解析、模型加载、同一 stream 的 partial/final、完整 WAV 兼容路径，以及 `StreamingASRSession` 不回退调用离线 `transcribe()`。
- 同一段 6.8 秒中文录音在 CPU 上逐套实际解码均产生 partial 和 final；当前受限运行环境屏蔽 GPU 设备，因此本轮没有重复 CUDA 实机加载，CUDA 基线见[模型管理稳定性与 CUDA](../../desktop/MODEL_MANAGEMENT.md)。

---

> 📖 [返回 ASR 总览 →](README.md) | [继续阅读流式设计 →](STREAMING.md)
