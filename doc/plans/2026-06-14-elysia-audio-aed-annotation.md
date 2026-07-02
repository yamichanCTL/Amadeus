# Plan: 新增爱莉希雅音频 AED 截取与打标

> **日期**: 2026-06-14
> **父文档**: [← 返回项目索引](../README.md)

## 任务目标

对新增的音频数据使用 FireRedASR2S AED 进行 VAD 语音检测 + ASR 识别 + 标点恢复，生成标注结果并与现有 Elysia 数据集合并。

## 输入数据

| # | 文件路径 | 大小 | 格式 |
|---|---------|------|------|
| 1 | `dataset/audio/Elysia/wavs/爱莉希雅-数据集.rar` | 737 MB | RAR 压缩包（待解压） |
| 2 | `dataset/audio/爱莉希雅语音合集_4h10min.wav` | 460 MB | 16kHz mono PCM WAV（4h10min） |
| 3 | `dataset/audio/Elysia/877257760-1-208.mp4` | 157 MB | MP4, AAC 48kHz stereo（7min49s，需提取音频） |

## 影响范围

| 模块/路径 | 变更类型 |
|-----------|----------|
| `dataset/audio/Elysia/wavs/` | 新增解压后的 wav 文件 |
| `dataset/audio/Elysia_annotation/` | 新增 result.jsonl + asr_srt/ + asr_tg/ |
| `dataset/audio/Elysia_new/` (新建) | 存放 4h10min.wav 分割片段 |
| `dataset/audio/Elysia_merged/` (新建) | 合并后的数据集和标注 |

## 技术方案

### 1. GPU VRAM 预算

| 项目 | 数值 |
|------|------|
| GPU | RTX 5070 Ti |
| 总显存 | 16303 MiB (~16 GB) |
| 目标用量 | ~15 GB（留 ~1 GB 余量） |

**模型显存估算**:

| 模型 | 磁盘大小 | FP32 GPU 占用 | FP16 GPU 占用 |
|------|---------|-------------|-------------|
| FireRedASR2-AED | 4.5 GB | ~4.7 GB | ~2.4 GB |
| FireRedLID | 3.4 GB | ~3.5 GB | ~1.8 GB |
| FireRedPunc | 1.3 GB | ~1.4 GB | ~0.7 GB |
| FireRedVAD | 6.8 MB | ~0.01 GB | ~0.01 GB |
| **合计** | **9.2 GB** | **~9.6 GB** | **~4.9 GB** |

**Batch size 推算**:
- 用户要求 **最高精度** (`--asr_use_half 0`, FP32)
- FP32 基础模型: ~9.6 GB，剩下 ~5.4 GB 给 batch 激活
- 现有脚本 batch_size=8, FP32 使用 ~14 GB
- 目标: `--asr_batch_size 10 --asr_use_half 0`，实测 ~14.8 GB（余量 ~1.2 GB ✅）

### 2. 实现步骤

#### Step 1: 安装 unrar，解压 RAR 文件
```bash
sudo apt install unrar
unrar x 爱莉希雅-数据集.rar -d /tmp/elysia_rar_extract/
```

#### Step 2: 音频格式标准化
- 检查解压出的 wav 格式
- 如有非 16kHz/mono 的，用 ffmpeg 转换为 16kHz mono PCM WAV
- MP4 提取音频: `ffmpeg -i 877257760-1-208.mp4 -ar 16000 -ac 1 -acodec pcm_s16le output.wav`
- 将 4h10min.wav 直接使用（已是 16kHz mono）

#### Step 3: 创建 16k 音频目录
```bash
mkdir -p ~/AI/dataset/audio/Elysia_new_16k/
# 复制/转换所有新增音频到此目录
```

#### Step 4: 运行 FireRedASR2S AED 打标

**批次划分**:
- 第 1 批: 解压的 RAR wav 文件（逐个文件，VAD 自动分割短片段）
- 第 2 批: 4h10min.wav（VAD 自动分割为短片段）

**ASR 参数**（FP32 最高精度 + 最大化 batch）:
```bash
--asr_type aed
--asr_batch_size 10      # FP32 下最大化（余量 ~1.2 GB）
--asr_use_half 0          # FP32 最高精度
--beam_size 3
--nbest 1
--return_timestamp 1
```

**VAD 参数**（保持现有配置）:
```bash
--speech_threshold 0.5
--min_speech_frame 20
--max_speech_frame 2000
--vad_chunk_max_frame 30000
```

**Punc 参数**:
```bash
--punc_batch_size 32
```

#### Step 5: 合并结果
- 将新的 result.jsonl 与现有 `Elysia_annotation/result.jsonl` 合并
- 去重（按 uttid）
- 生成合并后的 SRT/TextGrid

#### Step 6: 验证
- 检查合并后的条目数
- 检查 ASR 置信度分布
- 检查语言检测是否均为 zh mandarin

### 3. 输出产物

```
dataset/audio/
├── Elysia_new_16k/              # 新增 16kHz 音频
│   ├── <rar_extracted>/*.wav
│   └── 爱莉希雅语音合集_4h10min_segments/  # VAD 分割片段(可选)
├── Elysia_new_annotation/       # 新增标注
│   ├── result.jsonl
│   ├── asr_srt/
│   └── asr_tg/
└── Elysia_merged/               # 合并后数据集
    ├── wavs/                    # 全部 wav 的符号链接
    ├── result.jsonl             # 合并标注
    ├── asr_srt/
    └── asr_tg/
```

## 风险与注意事项

| 风险 | 影响 | 应对 |
|------|------|------|
| batch_size=24 显存溢出 | OOM 崩溃 | 逐步降低到 20/16/12 |
| RAR 内音频格式不标准 | ASR 报错 | 统一用 ffmpeg 转格式 |
| 4h10min.wav VAD 分割耗时长 | 处理时间久 | 正常，VAD 会自动分块处理 |
| 和现有标注 uttid 冲突 | 覆盖已有数据 | 去重时保留最新或合并 |
| unrar 安装失败 | 无法解压 | 尝试 7z 或 p7zip-full |
