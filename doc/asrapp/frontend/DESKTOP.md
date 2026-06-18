# Desktop — Electron 桌面客户端

> **父文档**: [← 返回 Frontend 总览](README.md)
> **子文档**: 无（叶子节点）
>
> **参考**: [桌面端入口](../../desktop/README.md)

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 桌面壳 | Electron 31 |
| UI | React 18 + Vite 5 + TypeScript 5 |
| 状态管理 | Zustand 4 (persist 持久化) |
| 打包 | electron-builder 24 |

## 架构

```
electron/main.ts          # 主进程：窗口、托盘、IPC、快捷键、鼠标 hook、浮窗
electron/preload.ts       # contextBridge → window.electronAPI
     │
     │ IPC
     ▼
src/                       # 渲染进程 (React)
├── main.tsx               # 入口（按平台加载样式）
├── App.tsx                # 布局、页面切换、状态轮询
├── pages/
│   ├── Transcribe.tsx     # 文件/录音转写 + 实时字幕
│   ├── Models.tsx         # ASR 模型管理
│   ├── Settings.tsx       # 后端地址、设备、快捷键、主题
│   └── History.tsx        # 本地历史（最大 200 条）
├── services/
│   ├── api.ts             # 后端 HTTP 客户端
│   ├── audio.ts           # MediaRecorder 录音 + 扬声器捕获
│   ├── hotkey.ts          # 快捷键/鼠标触发
│   └── export.ts          # TXT/SRT/JSON 导出
└── store/
    └── useASRStore.ts     # Zustand 全局状态
```

## 安全模型

- `nodeIntegration: false`
- `contextIsolation: true`
- 渲染进程只能通过 preload 调用白名单 API
- CSP 限制 connect-src（后端地址白名单）

## 核心能力

### 窗口控制
无边框窗口 + 自定义 TitleBar，支持最小化/最大化/关闭。

### 文件转写
拖拽或选择音频 → API 转写 → 展示结果 → 归档 → 复制/注入。

### 麦克风录音
MediaRecorder → audio/webm (Opus) → API 转写 → 自动注入文本。

### 实时字幕
捕获扬声器 loopback → 每 N 秒切片 → API 转写 → 桌面字幕浮窗。

### 全局触发键
支持键盘快捷键和鼠标按键（左/右/中/X1/X2），全局触发录音。

### 文本注入
Windows: 剪贴板 + Ctrl+V 自动注入到当前输入框。

---

> 📖 [桌面端入口 →](../../desktop/README.md) | [Android →](ANDROID.md)
