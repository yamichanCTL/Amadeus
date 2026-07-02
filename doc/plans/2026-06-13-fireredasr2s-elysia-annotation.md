# FireRedASR2S 为 Elysia 音频打标

## 目标
使用 FireRedASR2S 的 ASR 系统（ASR + VAD + LID + Punc）对 `~/AI/dataset/audio/Elysia/` 下 398 个中文普通话音频文件进行语音识别，生成带时间戳的标注结果。

## 影响范围
- `dataset/audio/Elysia/` - 398 个原始 wav 文件（44.1kHz 立体声）
- `dataset/audio/Elysia_16k/` - 转换后的 16kHz 单声道 wav（新建）
- `dataset/audio/Elysia_annotation/` - ASR 输出结果（新建）
- `audio/ASR/FireRedASR2S/pretrained_models/` - 下载的预训练模型

## 环境
- GPU: RTX 5070 Ti (16GB VRAM)
- CUDA: 13.1
- Python: 3.13.5 (luna-sama conda env, torch 2.8.0 已安装)
- FireRedASR2S 需要额外依赖: transformers, kaldiio, kaldi_native_fbank, sentencepiece, soundfile, cn2an

## 实现步骤

### 1. 音频格式转换
- 原始格式: 44100Hz, 2ch, s16le
- 目标格式: 16000Hz, 1ch (mono), s16le
- 使用 ffmpeg 批量转换
- 输出到 `dataset/audio/Elysia_16k/`

### 2. 安装依赖 & 下载模型
- 在 luna-sama 环境中安装缺失的 pip 包
- 通过 modelscope 下载 4 个预训练模型:
  - FireRedASR2-AED (ASR)
  - FireRedVAD (语音活动检测)
  - FireRedLID (语言识别)
  - FireRedPunc (标点预测)

### 3. 批量 ASR 推理
- 使用 fireredasr2s-cli 的 `--wav_dir` 模式批量处理
- 启用 VAD + LID + Punc，带时间戳
- 输出 JSONL + TextGrid + SRT 格式

### 4. 结果整理与文档更新
- 检查输出质量
- 更新 CHANGELOG

## 风险
- VRAM 可能不足（当前已用 ~10GB/16GB），需注意 batch_size 设置
- FireRedASR2-AED 最长支持 60s 音频，Elysia 音频约 7-10s，无问题
- Python 3.13 与新版 torch 可能与旧版 requirements.txt 不完全兼容，需适配
