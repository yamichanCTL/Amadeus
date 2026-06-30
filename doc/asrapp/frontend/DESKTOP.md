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
│   ├── Transcribe.tsx     # 文件确认识别 + 录音 + 实时字幕
│   ├── Models.tsx         # ASR 模型管理
│   ├── DebugConsole.tsx   # 延时与错误调试台
│   ├── Settings.tsx       # 后端地址、设备、快捷键、主题
│   └── History.tsx        # 本地历史（最大 200 条）
├── services/
│   ├── api.ts             # 后端 HTTP 客户端
│   ├── audio.ts           # MediaRecorder 录音 + 扬声器捕获
│   ├── telemetry.ts       # HTTP / ASR / TTS 内存遥测
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

### 语音识别
首次安装或清空后端地址后，桌面端不会主动连接任何后端、内网或公网地址。用户必须在设置页输入后端 IP/地址并点击“确认”，确认后才会执行健康检查、模型刷新、离线转写、实时字幕或 TTS 代理请求。

语音识别页顶部固定放置“开始录音”和“实时识别”两个主开关；文件识别区域位于页面底部。拖拽或选择音频 → 待确认 → 用户确认后调用 API → 展示结果 → 归档 → 复制/注入。页面不再显示“网络良好”和固定延迟/时间。

离线录音和文件识别可开启自动大模型润色。润色模型、接口和 Token 来自模型管理；语音识别页只保存润色 Prompt 和开关。前端会在请求中临时携带 Token，后端任务配置会排除 `api_token`，只保存脱敏后的模型、接口和 Prompt 信息。

### 麦克风录音
MediaRecorder → audio/webm (Opus) → API 转写 → 自动注入文本。

### 实时字幕
麦克风 16 kHz PCM → `/v1/stream` → X-ASR 原生 partial/final → 桌面字幕浮窗，不再把录音切片送入离线转写接口。开启实时识别时，如果“实时识别时显示桌面字幕框”已勾选，字幕框会立即同步显示；点击字幕框上的 × 会结束当前实时识别，但不会取消该持久设置。

### 图标
运行时窗口、托盘和 Windows 打包图标优先使用 `img/Amadeus/amadeus.ico`，Linux 打包图标使用 `img/Amadeus/amadeus-icon.png`，两者均由 `img/Amadeus/amadeus.jpg` 派生。

### 开发调试台
统一采集 HTTP 端到端/后端时间、WebSocket 建连和任务级 trace。文件 ASR 与实时 VAD→ASR→TTS 会展示阶段瀑布图，包括 ASR 首 token/final、TTS 首个可播放 token/chunk、完成与播放提交；支持筛选和 JSON 导出且不记录请求 body 或 Token。

### 全局触发键
新安装默认由键盘右 Alt 触发录音；旧版仍为默认鼠标中键且未自定义的设置会自动迁移。也可改用组合快捷键或鼠标按键（左/右/中/X1/X2）。Windows 通过右侧 Alt 专用 hook 保持全局触发；Linux/macOS 的单独右修饰键只在应用收到键盘事件时生效。

### 历史记录
历史页支持标题/内容、语言和“某日到某日”的组合筛选，起止日均包含在范围内。列表与详情时间统一显示本地 `YYYY-MM-DD HH:mm:ss`。清空筛选只复位条件，“清空全部记录”才删除历史。

### 文本注入
Windows: 剪贴板 + Ctrl+V 自动注入到当前输入框。

---

> 📖 [桌面端入口 →](../../desktop/README.md) | [Android →](ANDROID.md)
