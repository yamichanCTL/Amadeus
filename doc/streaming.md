这个方案可以设计成：

> **Always-on Mic → VAD 唤醒识别 → 伪流式实时显示 → 端点检测 → 完整语音段离线重识别 → 最终结果替换**

它本质是一个**“VAD 驱动的离线模型伪流式 ASR”**。对 SenseVoice、FireRedASR2、Whisper、离线 WeNet AED/CTC 都比较适合。

---

# 1. 总体架构

```text
麦克风常开
  ↓
Audio Capture / RingBuffer
  ↓
VAD 前端检测
  ↓
Utterance Buffer
  ↓
Partial ASR Scheduler
  ↓
Offline ASR Engine
  ↓
Partial Result Stabilizer
  ↓
UI 实时显示
  ↓
VAD Endpoint
  ↓
Final Offline ASR
  ↓
最终结果替换 partial
```

可以拆成 5 个核心模块：

```text
1. AudioCapture       负责持续采集麦克风 PCM
2. VADManager         负责判断开始说话、结束说话
3. ASRSessionManager  负责维护当前一句话的状态
4. ASREngine          负责调用离线模型推理
5. ResultManager      负责 partial/final 结果合并和显示
```

---

# 2. 状态机设计

推荐用状态机管理，不要用一堆 if else 硬拼。

```text
IDLE
  ↓ 检测到连续语音
LISTENING
  ↓ 周期性触发 partial 识别
PARTIAL_RECOGNIZING
  ↓ 静音达到 endpoint
FINALIZING
  ↓ final 结果完成
IDLE
```

更细一点：

```text
IDLE：麦克风开着，但没有人在说话
PRE_SPEECH：疑似开始说话，等待确认
SPEAKING：确认用户正在说话，开始缓存音频
PARTIAL：说话过程中周期性识别
POST_SPEECH：疑似说完，等待静音确认
FINAL：完整语音段离线识别
```

状态转移：

```text
IDLE
  └── vad_speech >= 200ms → SPEAKING

SPEAKING
  ├── every 320/500ms → partial ASR
  ├── silence >= 700ms → FINAL
  └── segment >= 10s/15s → force FINAL

FINAL
  └── final ASR done → IDLE
```

---

# 3. 音频缓存设计

需要两个 buffer。

## 3.1 RingBuffer：常开麦克风缓存

麦克风一直开，但不是所有音频都送 ASR。先写进环形缓存。

```text
RingBuffer:
  保存最近 2~3 秒音频
```

作用：

1. 防止 VAD 起点丢字；
2. VAD 检测到说话后，可以回溯前面 200~500ms；
3. 防止“你好”第一个字被截掉。

推荐：

```yaml
ring_buffer:
  sample_rate: 16000
  channels: 1
  sample_format: int16
  keep_ms: 3000
  pre_roll_ms: 300
```

当 VAD 判定用户开始说话时，不是从当前时刻开始截音频，而是从之前 300ms 开始：

```text
当前检测到 speech
  ↓
取 RingBuffer 中最近 300ms pre-roll
  ↓
作为 utterance 开头
```

---

## 3.2 UtteranceBuffer：当前一句话缓存

一旦进入 SPEAKING 状态，把后续音频写入当前 utterance buffer。

```text
UtteranceBuffer:
  pre_roll_audio + speaking_audio + tail_silence
```

这个 buffer 用于：

```text
partial 识别：取当前已缓存音频
final 识别：取完整一句话音频
```

---

# 4. VAD 设计

VAD 是这个方案的核心，不要让 ASR 自己判断用户是否说完。

推荐用：

```text
WebRTC VAD：轻量，CPU 低，适合实时
Silero VAD：效果更好，对噪声更稳
FSMN-VAD：中文语音场景常用
FireRedVAD：如果你已经在 FireRedASR2S 体系里
```

桌面输入法/实时字幕场景，我建议：

```yaml
vad:
  start_speech_ms: 200
  end_silence_ms: 700
  max_segment_ms: 10000
  min_segment_ms: 300
  pre_roll_ms: 300
  tail_keep_ms: 200
```

含义：

```text
连续 200ms 语音 → 认为开始说话
连续 700ms 静音 → 认为说完了
一句话超过 10s → 强制切句
小于 300ms → 丢弃，认为是噪声/误触发
```

---

# 5. Partial 流式显示怎么做

因为你的模型是离线模型，所以 partial 阶段推荐做**伪流式**。

例如每 500ms 调一次离线模型：

```text
第 1 次：0~0.5s 音频 → ASR → partial
第 2 次：0~1.0s 音频 → ASR → partial
第 3 次：0~1.5s 音频 → ASR → partial
第 4 次：0~2.0s 音频 → ASR → partial
...
```

不是每来 20ms 都识别，那样太浪费。

推荐参数：

```yaml
partial:
  infer_interval_ms: 500
  min_audio_ms_for_first_partial: 800
  max_window_sec: 10
  concurrency: 1
  cancel_stale_task: true
```

解释：

```text
infer_interval_ms: 每 500ms 刷新一次 partial
min_audio_ms_for_first_partial: 至少有 800ms 音频再开始识别
max_window_sec: 最大窗口 10s
concurrency: 同一时刻只允许一个 partial 识别任务
cancel_stale_task: 如果旧任务还没跑完，新任务来了，旧任务结果可以丢弃
```

---

# 6. Partial 识别的输入窗口

## 方案 1：当前整句重跑，最简单，效果最好

```text
partial 输入 = 当前 utterance 从开头到现在的全部音频
```

优点：

```text
上下文完整
效果接近离线
实现简单
```

缺点：

```text
每次都重复计算
句子越长越慢
```

适合：

```text
10s 以内短句
本地 GPU/NPU
模型推理够快
```

这是我最推荐你第一版实现的方案。

---

## 方案 2：滑动窗口，适合长语音

```text
partial 输入 = 最近 8~10s 音频
```

优点：

```text
计算稳定
不会越说越慢
```

缺点：

```text
容易丢前文
文本拼接复杂
```

如果你只是做语音输入法或短句字幕，暂时不要优先做这个。

---

## 方案 3：强制分句，工程上最稳

```text
如果当前 utterance 超过 10s：
  立即 final 当前段
  开启下一段
```

这是最稳的设计。

推荐：

```yaml
max_segment_sec: 10
hard_max_segment_sec: 15
```

也就是：

```text
10s 尝试切
15s 必须切
```

---

# 7. Partial 结果稳定算法

partial 结果会抖动，不能每次直接全量替换 UI。

例如：

```text
t=1.0s: 我想
t=1.5s: 我想打
t=2.0s: 我想打开
t=2.5s: 我想打开微信
t=3.0s: 我想打开一下微信
```

需要区分：

```text
stable_text：稳定文本
unstable_text：临时文本
```

## 简单做法：最长公共前缀 LCP

保存最近几次 partial：

```text
r1 = 我想打开
r2 = 我想打开微
r3 = 我想打开微信
```

公共前缀：

```text
我想打开
```

这个部分可以认为稳定。

伪代码：

```python
def longest_common_prefix(a: str, b: str) -> str:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return a[:i]
```

更稳一点：

```text
连续 2~3 次都出现在相同前缀位置 → stable
最新一次剩余部分 → unstable
```

UI 显示：

```text
我想打开    微信
稳定文本    临时文本
```

---

# 8. Final 离线识别

VAD 检测到用户说完后，对完整 utterance 重新跑一次离线模型：

```text
完整音频段 → offline ASR → final_text
```

然后：

```text
用 final_text 替换当前 partial_text
```

这个 final 结果才进入历史记录、文本注入、文件保存。

不要把 partial 直接当最终结果，否则会有错字、缺字、重复字。

---

# 9. 最推荐的时间参数

你可以直接用这一套：

```yaml
audio:
  sample_rate: 16000
  channels: 1
  frame_ms: 20
  format: int16

ring_buffer:
  keep_ms: 3000
  pre_roll_ms: 300

vad:
  start_speech_ms: 200
  end_silence_ms: 700
  min_segment_ms: 300
  max_segment_ms: 10000
  hard_max_segment_ms: 15000
  tail_keep_ms: 200

partial:
  enabled: true
  first_partial_after_ms: 800
  infer_interval_ms: 500
  max_window_ms: 10000
  stable_times: 2
  max_concurrent_jobs: 1
  drop_outdated_partial: true

final:
  enabled: true
  run_after_endpoint: true
  replace_partial: true
```

如果模型很快，比如 GPU/NPU 上 FireRedASR2 推理 10s 音频只要几十毫秒，可以改成：

```yaml
partial:
  infer_interval_ms: 320
```

如果模型较慢，比如 CPU 上 SenseVoice/Whisper，可以用：

```yaml
partial:
  infer_interval_ms: 800
```

---

# 10. 线程/进程设计

推荐至少分 4 个线程或异步任务：

```text
Audio Thread:
  只负责采集音频，不能被 ASR 阻塞

VAD Thread:
  负责实时判断 speech/silence

ASR Worker:
  负责 partial/final 推理

UI/Main Thread:
  负责显示结果
```

不要在音频采集线程里直接跑 ASR。

否则 ASR 一卡，音频就丢帧。

---

## 推荐队列结构

```text
AudioCapture
  ↓ audio_frame_queue
VADManager
  ↓ vad_event_queue
ASRSessionManager
  ↓ asr_job_queue
ASRWorker
  ↓ result_queue
UI
```

ASR job 可以分两类：

```python
class ASRJob:
    job_id: int
    session_id: str
    job_type: Literal["partial", "final"]
    audio: bytes
    audio_duration_ms: int
    created_at: float
```

结果也分两类：

```python
class ASRResult:
    session_id: str
    job_id: int
    result_type: Literal["partial", "final"]
    text: str
    stable_text: str | None
    unstable_text: str | None
    is_final: bool
```

---

# 11. 防止旧 partial 覆盖新结果

这是很容易踩的坑。

例如：

```text
partial job 1：0~1s，耗时 600ms
partial job 2：0~2s，耗时 200ms
```

可能 job 2 先返回，job 1 后返回。

如果不处理，就会出现：

```text
新结果显示了 → 旧结果又覆盖回来
```

解决方法：

```text
每个 job 带 job_id
只接受最新 job_id 的结果
旧结果直接丢弃
```

伪代码：

```python
if result.job_id < session.latest_partial_job_id:
    discard(result)
else:
    apply(result)
```

final 优先级最高：

```text
一旦 final 完成，所有 pending partial 全部丢弃
```

---

# 12. 静音误识别处理

离线模型做 partial 时经常会有“静音出字”问题，尤其 Whisper、部分 AED 模型明显。

要加几层保护：

## 12.1 VAD 没有 speech，不跑 ASR

```text
IDLE 状态下绝不调用 ASR
```

## 12.2 音频太短，不跑 ASR

```text
当前语音 < 800ms，不跑 partial
当前语音 < 300ms，不跑 final
```

## 12.3 final 前检查有效语音占比

```text
speech_ratio 太低 → 丢弃
```

例如：

```text
10s 音频里只有 200ms speech
不要送 final
```

## 12.4 过滤常见幻觉文本

例如模型经常静音输出：

```text
谢谢观看
字幕由 Amara.org 社区提供
嗯
啊
```

可以配置 blacklist，但不要过度依赖。

---

# 13. 和你的 ASRAPP 后端怎么对接

你之前的架构里有 FastAPI 后端和 Electron/Android 前端。这里建议这样设计接口。

## 本地桌面模式

如果 ASR 服务在本机：

```text
Electron 前端采集麦克风
  ↓
WebSocket 发送 PCM chunk 给本地 FastAPI
  ↓
FastAPI 后端做 VAD + ASR
  ↓
WebSocket 返回 partial/final
```

接口：

```text
WS /v1/stream
```

客户端发送：

```json
{
  "type": "audio",
  "sample_rate": 16000,
  "format": "pcm_s16le",
  "data": "base64..."
}
```

服务端返回：

```json
{
  "type": "partial",
  "session_id": "xxx",
  "stable_text": "我想打开",
  "unstable_text": "微信",
  "text": "我想打开微信"
}
```

final：

```json
{
  "type": "final",
  "session_id": "xxx",
  "text": "我想打开微信",
  "duration_sec": 2.34,
  "engine": "fireredasr2"
}
```

---

## Android 模式

Android 上建议：

```text
Android 端采集 PCM
Android 端可做轻量 VAD
云端/本地服务做 ASR
```

两种方式：

### 方式 A：Android 只采集，后端做 VAD + ASR

优点：

```text
前端简单
VAD/ASR 逻辑统一
```

缺点：

```text
一直传音频，带宽和隐私成本高
```

### 方式 B：Android 本地 VAD，检测到说话才上传

优点：

```text
省流量
更省电
隐私更好
```

缺点：

```text
Android 端要实现 VAD
```

实际产品更推荐 B：

```text
麦克风常开
  ↓
Android 本地 VAD
  ↓
检测到说话后才上传 PCM/Opus
  ↓
服务端 partial/final ASR
```

---

# 14. 是否要压缩音频传输？

如果是本机 Electron 到本机 FastAPI：

```text
直接 PCM 16k int16 即可
```

带宽：

```text
16000 samples/s × 2 bytes = 32 KB/s
```

非常小。

如果是 Android 到云端：

```text
建议 Opus
```

例如：

```text
16k mono Opus 16~24 kbps
```

但是注意：

```text
ASR 最终通常还是需要 PCM/fbank
服务端要解码 Opus
```

低延迟流式一般可以用：

```text
20ms Opus packet
```

---

# 15. 推荐第一版实现

你第一版不要做复杂真流式，直接这样做：

```text
1. 麦克风常开，采集 16k mono PCM
2. RingBuffer 保存最近 3s
3. Silero/WebRTC VAD 判断 start/end
4. start 后取 300ms pre-roll
5. speaking 状态下每 500ms 调一次 offline ASR
6. 用 LCP 做 stable/unstable partial
7. silence 700ms 后跑完整 final
8. final 替换 partial
9. 清空 utterance，回到 IDLE
```

这版就能达到“边说边显示，说完后准确修正”的效果。

---

# 16. 推荐流程图

```text
┌──────────────┐
│ Mic Always On│
└──────┬───────┘
       ↓
┌──────────────┐
│ Ring Buffer  │ 保存最近 3s
└──────┬───────┘
       ↓
┌──────────────┐
│ VAD Detect   │
└──────┬───────┘
       │
       ├── no speech ──→ stay IDLE
       │
       └── speech
             ↓
      ┌──────────────┐
      │ Utterance Buf│ 加入 pre-roll
      └──────┬───────┘
             ↓
      ┌──────────────┐
      │ Partial Timer│ 每 500ms
      └──────┬───────┘
             ↓
      ┌──────────────┐
      │ Offline ASR  │ 当前已说音频
      └──────┬───────┘
             ↓
      ┌──────────────┐
      │ Stable Merge │
      └──────┬───────┘
             ↓
      ┌──────────────┐
      │ UI Partial   │
      └──────┬───────┘
             ↓
      VAD silence >= 700ms?
             ↓ yes
      ┌──────────────┐
      │ Final ASR    │ 完整音频段
      └──────┬───────┘
             ↓
      ┌──────────────┐
      │ UI Final     │ 替换 partial
      └──────────────┘
```

---

# 17. 最关键的工程原则

## 原则 1：采集线程不能被推理阻塞

ASR 再慢，麦克风也要持续采集。

---

## 原则 2：VAD 决定是否启动 ASR

不要 IDLE 时一直跑 ASR。

---

## 原则 3：partial 只负责体验，final 负责准确率

partial 可以错，final 必须重新识别完整语音段。

---

## 原则 4：一句话不要无限增长

超过 10~15s 必须切段，否则离线模型、UI、缓存、延迟都会恶化。

---

## 原则 5：过期 partial 必须丢弃

否则 UI 会回退。

---

# 18. 推荐技术选型

针对你的场景：

```text
VAD：
  第一版：WebRTC VAD / Silero VAD
  中文更稳：FSMN-VAD / FireRedVAD

ASR：
  FireRedASR2 / SenseVoice / WeNet / Whisper 均可

通信：
  Electron 本地：WebSocket + PCM
  Android 云端：WebSocket + Opus/PCM

后端：
  FastAPI WebSocket
  ASR Engine 常驻内存
  一个 ASR worker 串行处理同一个 session
```

---

# 19. 最终推荐方案

你的方案可以定为：

```text
VAD-driven pseudo-streaming offline ASR
```

中文可以叫：

```text
基于 VAD 的离线模型伪流式识别方案
```

最终设计：

```text
麦克风常开
  → 本地 VAD 检测说话
  → 取 300ms pre-roll 防丢字
  → speaking 期间每 500ms 用离线模型重跑当前语音段
  → UI 显示 stable partial + unstable partial
  → 静音 700ms 判定说完
  → 完整语音段 final 离线识别
  → final 替换 partial
  → 回到等待说话状态
```

这套方案的优点是：

```text
不需要重新训练流式模型
最终准确率接近离线模型
实时显示体验可接受
工程复杂度适中
适合桌面语音输入法、实时字幕、Android 云端 ASR
```
