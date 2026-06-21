# 第三方库与模型

> **父文档**: [← 返回环境安装总览](README.md)
> **子文档**: [后端环境](BACKEND.md) · [迁移检查表](MIGRATION.md)

## ASR/VAD/标点模型矩阵

| 功能 | Python 库/源码 | 模型或本地目录 | 用途 |
|---|---|---|---|
| X-ASR | `sherpa-onnx` CUDA/CPU wheel；`thirdparty/X-ASR` | `thirdparty/X-ASR/X-ASR-zh-en/deployment/models/chunk-{160,480,960,1920}ms-model` | 默认真流式中英 ASR |
| FireRedASR2 | PyTorch、FireRedASR2S 源码及 `[firered]` extra | `backend/models/fireredasr2/FireRedASR2-AED` | 默认离线 ASR |
| FireRedVAD | FireRedASR2S 源码 | `backend/models/fireredasr2/FireRedVAD/Stream-VAD` | WebSocket 话语边界 |
| SenseVoice | FunASR、PyTorch | `backend/models/SenseVoiceSmall` | 多语种离线识别 |
| Qwen3-ASR | `qwen-asr`、Transformers、PyTorch | `backend/models/Qwen3-ASR-1.7B` 或模型名 `Qwen/Qwen3-ASR-1.7B` | 大模型离线 ASR |
| Whisper | `faster-whisper` | `backend/models/whisper/<size>` 或自动缓存 | 通用离线 ASR |
| CT-Punc | FunASR | `ct-punc`（首次使用由 FunASR/ModelScope 缓存） | 可选标点恢复 |

X-ASR 官方权重下载方式：

```bash
git clone https://github.com/Gilgamesh-J/X-ASR.git thirdparty/X-ASR
cd thirdparty/X-ASR
hf download GilgameshWind/X-ASR-zh-en --local-dir ./X-ASR-zh-en/deployment
```

FireRed 模型可通过 ModelScope 下载到项目约定目录：

```bash
modelscope download --model xukaituo/FireRedASR2-AED --local_dir backend/models/fireredasr2/FireRedASR2-AED
modelscope download --model xukaituo/FireRedVAD --local_dir backend/models/fireredasr2/FireRedVAD
```

权重目录必须保留 Git LFS 的实际大文件，只有 pointer 文件会导致加载失败。X-ASR CUDA 验证：

```bash
uv run --no-sync python scripts/verify_x_asr_cuda.py
```

## Higgs Audio TTS

Higgs Audio 不安装在本仓 Python 环境内；桌面/后端把它当作 OpenAI 风格的外部服务。当前本机参考组合为独立 `higgs-audio` 仓库、`higgs-audio-v3-tts-4b` 权重及其 `thirdparty/sglang-omni` 环境：

```bash
cd /path/to/higgs-audio/thirdparty/sglang-omni
PATH="$PWD/.venv/bin:$PATH" \
FLASHINFER_CUDA_ARCH_LIST=9.0a \
SGLANG_OMNI_STARTUP_TIMEOUT=1800 \
.venv/bin/sgl-omni serve \
  --model-path /path/to/higgs-audio-v3-tts-4b \
  --port 8002 \
  --stages.2.factory_args.server_args_overrides.mem_fraction_static 0.6 \
  --stages.2.factory_args.server_args_overrides.max_running_requests 4
```

`FLASHINFER_CUDA_ARCH_LIST` 必须按目标 GPU 调整。桌面端默认访问 `http://localhost:8002`；也可在模型管理中切换 Boson 远程接口。VoxCPM 可通过 `[voxcpm]` extra 安装；GPT-SoVITS 等 Runner TTS 属于可选外部运行时，不是桌面 Higgs 实时链路的必要依赖。

## CUDA 兼容验收

逐层检查 NVIDIA 驱动、PyTorch CUDA、sherpa-onnx provider、cuDNN major/minor 与实际 decode。出现 `CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH` 时应重新安装匹配的 wheel/动态库，不能通过重启或增加显存解决。

