# VAD 驱动的伪流式 ASR 方案

> **父文档**: [← 返回 ASR 总览](README.md)
>
> **参考**: 当前文档为维护中的伪流式 ASR 设计说明

---

## 核心思路

离线 ASR 引擎不支持真流式。通过 **VAD 检测 + 分段离线识别** 模拟实时效果：

```
Always-on Mic → VAD 检测语音 → 500ms 间隔 partial ASR →
LCP 稳定化 → 静音 700ms 触发 final ASR → 替换 partial
```

## 状态机

```
IDLE
  └── speech ≥ 200ms → SPEAKING
SPEAKING
  ├── 每 500ms → partial ASR
  ├── silence ≥ 700ms → FINAL
  └── segment ≥ 10s → 强制 FINAL
FINAL
  └── final ASR done → IDLE
```

## 双 Buffer 设计

| Buffer | 大小 | 作用 |
|--------|------|------|
| **RingBuffer** | 3s | 常开麦克风缓存，提供 pre-roll 防丢字 |
| **UtteranceBuffer** | 可变 | 当前一句话完整音频（含 pre-roll + tail silence） |

## Partial 识别策略

### 方案 1：当前整句重跑（推荐第一版）
```
partial 输入 = 当前 utterance 从开头到现在的全部音频
```
- ✅ 上下文完整，效果接近离线
- ❌ 句子越长越慢
- 适合 10s 以内短句

### 方案 2：滑动窗口
```
partial 输入 = 最近 8~10s 音频
```
- ✅ 计算稳定
- ❌ 可能丢前文

### 方案 3：强制分句（最稳）
```
10s 尝试切句，15s 必须切句
```

## LCP 稳定化算法

```
t=1.0s → "我想"
t=1.5s → "我想打"
t=2.0s → "我想打开"
t=2.5s → "我想打开微信"

稳定文本: "我想打开" (连续 2 次相同前缀)
不稳定文本: "微信" (最新结果剩余部分)
```

UI 显示：`我想打开` `微信`（稳定 / 不稳定分色）

## 推荐参数

```yaml
vad:
  start_speech_ms: 200       # 连续语音确认
  end_silence_ms: 700        # 静音=说完
  max_segment_ms: 10000      # 超时强制切句
  pre_roll_ms: 300           # 回溯防丢字

partial:
  infer_interval_ms: 500     # partial 推理间隔
  stable_times: 2            # LCP 确认次数
  max_concurrent_jobs: 1     # 串行，丢旧取新
```

## 协同推理（推荐组合）

```
VAD 检测 →
  SenseVoice Small (partial，每 500ms，速度快)
  → 静音结束 →
  FireRedASR2 (final，完整语音段，精度最高)
  → final 替换 partial
```

## 工程原则

| # | 原则 |
|---|------|
| 1 | 采集线程不能被推理阻塞 |
| 2 | VAD 决定是否启动 ASR，不要 IDLE 时跑 ASR |
| 3 | Partial 负责体验，Final 负责准确率 |
| 4 | 一句话不超过 10~15s，超时强制切 |
| 5 | 过期 partial 必须丢弃，防止 UI 回退 |

## 线程设计

```
Audio Thread  → 只采集，不阻塞
VAD Thread    → 实时判断 speech/silence
ASR Worker    → partial/final 推理
UI Thread     → 显示结果
```

---

> 📖 [引擎对比 →](ENGINES.md)
