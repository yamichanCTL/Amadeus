# Frontend — 客户端总览

> **父文档**: [← 返回 asrapp 总览](../README.md)
> **子文档**:
> - [Desktop](DESKTOP.md) — Electron + React 桌面客户端
> - [Android](ANDROID.md) — Android 移动客户端

---

## 两个客户端

| 客户端 | 技术栈 | 平台 |
|--------|--------|------|
| Desktop | Electron 31 + React 18 + Vite 5 + TypeScript 5 + Zustand 4 | Windows / macOS / Linux |
| Android | Kotlin + Gradle | Android |

## 功能对比

| 功能 | Desktop | Android |
|------|---------|---------|
| 文件拖拽转写 | ✅ | — |
| 麦克风录音转写 | ✅ | ✅ |
| 扬声器实时字幕 | ✅ (Windows) | — |
| 全局快捷键触发 | ✅ | — |
| 鼠标按键触发 | ✅ | — |
| 系统托盘后台 | ✅ | — |
| 桌面字幕浮窗 | ✅ | — |
| 自动文本注入 | ✅ (Windows) | — |
| 模型加载/卸载 | ✅ | — |
| 历史记录导出 | ✅ (TXT/SRT/JSON) | — |
| 后台持续识别 | ✅ | ✅ (含锁屏) |

## 与后端通信

```
Desktop/Android
     │
     ├─ HTTP REST → /v1/transcribe, /v1/models, /v1/tasks...
     ├─ WebSocket → /v1/stream (流式识别)
     └─ 默认后端: http://10.154.39.91:8001
```

---

> 📖 [Desktop 详解 →](DESKTOP.md) | [Android 详解 →](ANDROID.md)
