# Android 移动客户端

> **父文档**: [← 返回 Frontend 总览](README.md)

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | Kotlin |
| 构建 | Gradle |
| 通信 | HTTP + WebSocket |

## 核心流程

```
Android Mic 采集 PCM
    │
    ├─ 本地 VAD 检测（轻量）
    │   ├─ speech → 上传音频流
    │   └─ silence → 停止上传
    │
    ▼
后端 ASR 推理 → 返回转写结果
```

## VAD 策略

- 方式 A：Android 只采集，后端做 VAD + ASR（简单，但费流量）
- 方式 B：Android 本地 VAD，检测到说话才上传（省流量、省电、隐私好）✅ 推荐

## 锁屏持续识别

- 前台 Service + WakeLock 保持后台运行
- 锁屏后继续采集音频和识别
- 需要 `FOREGROUND_SERVICE` 权限

## 按键区分

- **实时转录按键**：长按说话，松开停止 → 持续识别模式
- **一段语音转写按键**：点击开始/停止 → 单次识别模式
- 两种模式在 UI 上明确区分

## 数据归档

支持按用户/日期/类型保存：

```
data/archive/{user}/{YYYY-MM-DD}/{type}/
├── {task_id}_{audio}.wav
└── {task_id}_{audio}.json
```

`type`: `realtime_transcription`（实时转录）| `single_utterance`（一段语音）

---

> 📖 [Desktop 客户端 →](DESKTOP.md) | [后端 API →](../backend/API.md)
