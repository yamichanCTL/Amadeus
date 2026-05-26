# ASR Desktop 前端复现技术文档

本文档基于 `frontend/desktop` 当前源码整理，目标是让开发者只依赖本文档和仓库源码即可完整复现、开发、构建 Electron 桌面端。

## 1. 项目定位

`frontend/desktop` 是 ASRAPP 的桌面客户端，采用 Electron + React + Vite + TypeScript 实现。

主要能力：

- 连接后端 ASR HTTP 服务。
- 拖拽或选择音频文件进行转写。
- 使用麦克风录音，停止后提交转写。
- 捕获扬声器输出，按固定时长切片做实时字幕。
- 管理 ASR 模型加载、卸载和默认识别引擎。
- 保存本地历史记录，并导出 TXT、SRT、JSON。
- 在 Windows 上支持全局键盘快捷键、鼠标按键触发、托盘后台运行、桌面状态浮窗、桌面字幕浮窗、识别结果自动粘贴。

## 2. 技术栈与版本来源

版本以 `frontend/desktop/package.json` 和 `package-lock.json` 为准。

| 类型 | 技术 |
|---|---|
| 桌面壳 | Electron 31 |
| UI | React 18 |
| 构建 | Vite 5 |
| 语言 | TypeScript 5 |
| 状态管理 | Zustand 4，使用 persist 中间件持久化 |
| 打包 | electron-builder 24 |
| 开发并发启动 | concurrently |

建议环境：

- Windows 10/11 优先，当前大量系统能力只在 Windows 实现。
- Node.js 20 LTS。
- npm，使用仓库内 `package-lock.json` 锁定依赖。
- 后端 ASR 服务可访问，默认地址为 `http://10.154.39.91:8001`。

## 3. 目录结构

```text
frontend/desktop/
  electron/
    main.ts
    preload.ts
  scripts/
    electron-dev.js
  src/
    main.tsx
    App.tsx
    vite-env.d.ts
    components/
    pages/
    services/
    store/
    styles/
  index.html
  package.json
  package-lock.json
  vite.config.ts
  tsconfig.json
  tsconfig.node.json
  electron-builder.yml
```

关键目录职责：

| 路径 | 职责 |
|---|---|
| `electron/main.ts` | Electron 主进程。创建窗口、托盘、IPC、快捷键、鼠标 hook、浮窗、文件系统访问、剪贴板和文本注入。 |
| `electron/preload.ts` | 通过 `contextBridge` 暴露受控的 `window.electronAPI`。 |
| `scripts/electron-dev.js` | 开发模式等待 Vite 5173 端口就绪，编译 Electron 主进程后启动 Electron。 |
| `src/main.tsx` | React 渲染入口，按平台加载 `global.css` 或 `mac.css`。 |
| `src/App.tsx` | 应用布局、页面切换、主题初始化、服务状态轮询、触发键恢复、浮窗事件监听。 |
| `src/pages/Transcribe.tsx` | 文件转写、录音转写、实时字幕、历史写入、归档和文本注入的核心流程。 |
| `src/pages/Models.tsx` | 模型列表、加载、卸载、热切换和默认引擎选择。 |
| `src/pages/Settings.tsx` | 后端地址、音频设备、字幕、触发键、主题、数据保存配置。 |
| `src/pages/History.tsx` | 本地历史查看、复制、导出、删除、清空。 |
| `src/services/api.ts` | 后端 HTTP API 客户端。 |
| `src/services/audio.ts` | MediaDevices、MediaRecorder、麦克风录音、扬声器输出切片。 |
| `src/services/hotkey.ts` | 快捷键和鼠标触发封装。 |
| `src/services/export.ts` | TXT、SRT、JSON 导出和复制。 |
| `src/store/useASRStore.ts` | 全局状态、设置、历史记录持久化。 |

构建产物目录不参与源码复现：

```text
frontend/desktop/node_modules/
frontend/desktop/dist/
frontend/desktop/dist-electron/
frontend/desktop/release/
frontend/desktop/*.tsbuildinfo
```

## 4. 从零复现步骤

### 4.1 安装依赖

```powershell
cd D:\project\audio\ASR\ASRAPP\frontend\desktop
npm install
```

优先使用 `npm install`，不要删除 `package-lock.json`。如果要严格按锁文件复现 CI 环境，可用：

```powershell
npm ci
```

### 4.2 启动后端

桌面端本身不内置 ASR 推理服务，需要后端服务已启动并可访问。

默认后端地址来自：

- `src/store/useASRStore.ts` 的 `DEFAULT_SETTINGS.serverUrl`
- `src/services/api.ts` 的 `ASRApi` 默认构造参数

当前默认值：

```text
http://10.154.39.91:8001
```

前端会调用：

```text
GET  /v1/health
GET  /v1/models
POST /v1/models/{engine}/load
POST /v1/models/{engine}/unload
POST /v1/transcribe
GET  /v1/tasks/{task_id}
GET  /v1/tasks?limit=&offset=
POST /v1/tasks/{task_id}/cancel
```

如果后端地址不同，在应用的“设置”页修改“后端地址”，或修改源码默认值后重新构建。

### 4.3 开发模式运行

```powershell
npm run dev
```

该命令实际执行：

```text
concurrently -k "vite" "node scripts/electron-dev.js"
```

流程：

1. Vite 启动 React dev server，端口固定为 `5173`。
2. `scripts/electron-dev.js` 轮询 `http://localhost:5173`。
3. Vite 就绪后执行 `tsc -b tsconfig.node.json --force` 编译 `electron/` 到 `dist-electron/`。
4. Electron 以项目根 `.` 启动。
5. 开发模式下主窗口加载 `http://localhost:5173`，并打开 DevTools。

如果 5173 被占用，Vite 配置了 `strictPort: true`，需要先释放端口。

### 4.4 类型检查与构建

完整构建：

```powershell
npm run build
```

Windows 安装包：

```powershell
npm run build:win
```

Linux 包：

```powershell
npm run build:linux
```

构建流程：

```text
tsc
  -> 校验 src/ 渲染进程 TypeScript 类型，不输出文件
vite build
  -> 输出 renderer 静态资源到 dist/
tsc -p tsconfig.node.json
  -> 输出 Electron main/preload 到 dist-electron/
electron-builder
  -> 按 electron-builder.yml 打包到 release/
```

## 5. 配置文件说明

### 5.1 `package.json`

关键字段：

```json
{
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "concurrently -k \"vite\" \"node scripts/electron-dev.js\"",
    "build": "tsc && vite build && tsc -p tsconfig.node.json && electron-builder",
    "build:win": "tsc && vite build && tsc -p tsconfig.node.json && electron-builder --win",
    "build:linux": "tsc && vite build && tsc -p tsconfig.node.json && electron-builder --linux",
    "preview": "vite preview"
  }
}
```

Electron 启动入口必须是 `dist-electron/main.js`，所以开发脚本和构建脚本都必须先编译 `electron/`。

### 5.2 `vite.config.ts`

关键配置：

- `base: './'`：保证打包后从本地文件系统加载资源。
- `@` 别名指向 `src`。
- dev server 固定 `5173` 端口。
- renderer 输出目录为 `dist`。
- Electron 主进程不通过 Vite 构建，而是由 `tsc -p tsconfig.node.json` 编译。

### 5.3 `tsconfig.json`

用于 React 渲染进程：

- `target: ES2020`
- `module: ESNext`
- `moduleResolution: bundler`
- `jsx: react-jsx`
- `strict: true`
- `noEmit: true`
- `@/* -> src/*`

### 5.4 `tsconfig.node.json`

用于 Electron 主进程和 preload：

- `module: CommonJS`
- `target: ES2020`
- `rootDir: electron`
- `outDir: dist-electron`
- `composite: true`

### 5.5 `electron-builder.yml`

打包输出目录为 `release`，安装包包含：

```yaml
files:
  - dist/**/*
  - dist-electron/**/*
  - "!dist-electron/electron/**/*"
```

Windows 目标：

- NSIS installer
- x64
- 支持选择安装目录
- 创建桌面快捷方式和开始菜单快捷方式

配置中引用了：

```text
build/icon.ico
build/icon.icns
build/icon.png
```

复现打包时需要准备这些资源，或者调整 `electron-builder.yml` 删除/替换图标路径。

### 5.6 `index.html`

入口挂载点：

```html
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
```

CSP 当前允许连接：

```text
self
http://localhost:*
http://127.0.0.1:*
http://10.154.39.91:*
http://10.154.39.93:*
```

如果后端部署到其他域名或 IP，需要同步调整 `connect-src`。

## 6. Electron 主进程复现要点

### 6.1 应用生命周期

`electron/main.ts` 中：

- `app.requestSingleInstanceLock()` 限制单实例。
- 开发模式把 `userData` 指向系统临时目录下的 `asr-desktop-dev`。
- `createWindow()` 创建无边框主窗口。
- 开发模式加载 `http://localhost:5173`。
- 生产模式加载 `../dist/index.html`。
- Windows 关闭窗口时弹出“后台运行/退出/取消”选择，并可记住选择。
- `will-quit` 时注销全局快捷键、停止鼠标 hook、销毁托盘。

### 6.2 主窗口配置

```ts
new BrowserWindow({
  width: 1100,
  height: 720,
  minWidth: 800,
  minHeight: 560,
  frame: false,
  titleBarStyle: 'hidden',
  backgroundColor: '#f3f3f3',
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false
  }
})
```

渲染进程不能直接访问 Node.js，只能通过 preload 暴露的 `window.electronAPI` 调用系统能力。

### 6.3 Windows 扬声器捕获

主进程在 Windows 上调用：

```ts
session.defaultSession.setDisplayMediaRequestHandler(...)
```

返回第一个 screen source，并启用：

```text
audio: 'loopback'
```

渲染进程中的实时字幕会通过 `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })` 捕获系统播放声音，然后立即停止视频轨，只保留音频轨。

### 6.4 托盘与关闭行为

Windows 下关闭主窗口时：

- 如果用户选择后台运行，窗口隐藏到托盘。
- 如果选择退出，设置 `forceQuit = true` 并退出应用。
- 用户选择“记住我的选择”后，偏好写入：

```text
app.getPath('userData')/preferences.json
```

开发模式路径：

```text
%TEMP%/asr-desktop-dev/preferences.json
```

## 7. Preload API 与 IPC 契约

`electron/preload.ts` 暴露：

```ts
window.electronAPI
```

主要能力如下。

### 7.1 窗口控制

| Renderer API | IPC | 类型 |
|---|---|---|
| `minimize()` | `win:minimize` | send |
| `maximize()` | `win:maximize` | send |
| `close()` | `win:close` | send |

### 7.2 文件与归档

| Renderer API | IPC | 说明 |
|---|---|---|
| `openAudioDialog()` | `dialog:openAudio` | 选择多个音频文件 |
| `openDirectoryDialog()` | `dialog:openDirectory` | 选择保存目录 |
| `getDefaultArchiveDir()` | `app:defaultArchiveDir` | 获取/创建默认归档目录 |
| `saveFileDialog(name)` | `dialog:saveFile` | 保存 TXT/SRT/JSON |
| `writeFile(path, content)` | `fs:writeFile` | UTF-8 写文件 |
| `readFileBase64(path)` | `fs:readFileBase64` | 读取本地文件为 base64 |
| `fileInfo(path)` | `fs:fileInfo` | 获取文件大小和文件名 |
| `archiveTranscription(args)` | `archive:transcription` | 保存音频和 JSON 到日期目录 |

归档文件路径规则：

```text
{archiveRoot}/YYYY-MM-DD/{taskId}_{audioStem}{ext}
{archiveRoot}/YYYY-MM-DD/{taskId}_{audioStem}.json
```

### 7.3 主题与外链

| Renderer API | IPC | 说明 |
|---|---|---|
| `openExternal(url)` | `shell:openExternal` | 用系统浏览器打开 URL |
| `getTheme()` | `theme:get` | 获取当前系统深浅色 |
| `setTheme(theme)` | `theme:set` | 设置 Electron nativeTheme |

### 7.4 触发键

| Renderer API | IPC | 说明 |
|---|---|---|
| `registerHotkey(acc)` | `hotkey:register` | 注册 Electron globalShortcut |
| `unregisterHotkey()` | `hotkey:unregister` | 注销当前键盘快捷键 |
| `onHotkeyTriggered(cb)` | `hotkey:triggered` | 主进程触发录音 |
| `registerMouseButton(btn)` | `mouse:register` | Windows PowerShell hook 捕获鼠标按钮 |
| `unregisterMouseButton()` | `mouse:unregister` | 停止鼠标 hook |

支持鼠标按钮内部名：

```text
mouse_left
mouse_right
mouse_middle
mouse_x1
mouse_x2
```

### 7.5 文本输出

| Renderer API | IPC | 说明 |
|---|---|---|
| `injectText(text)` | `text:inject` | 写入剪贴板，Windows 下向当前窗口发送 Ctrl+V |
| `textToClipboard(text)` | `text:toClipboard` | 仅写入剪贴板 |

`text:inject` 的策略：

1. 先写入系统剪贴板。
2. 如果 ASR 主窗口当前聚焦，不自动粘贴，避免粘贴到自己。
3. 如果其他应用聚焦，发送 `Ctrl+V`。
4. 非 Windows 平台只保证剪贴板写入。

### 7.6 浮窗

| Renderer API | IPC | 说明 |
|---|---|---|
| `showStatusOverlay(status)` | `statusOverlay:show` | 显示“语音输入中/转写中”状态浮窗 |
| `hideStatusOverlay()` | `statusOverlay:hide` | 隐藏状态浮窗 |
| `showCaptionOverlay(text, options)` | `captionOverlay:show` | 显示桌面字幕 |
| `hideCaptionOverlay()` | `captionOverlay:hide` | 隐藏桌面字幕 |
| `onCaptionOverlayClosed(cb)` | `captionOverlay:closedByUser` | 用户关闭字幕浮窗 |
| `onCaptionOverlayStyleChanged(cb)` | `captionOverlay:styleChanged` | 用户拖动/调整字幕浮窗 |
| `onCaptionOverlaySettingsRequested(cb)` | `captionOverlay:settingsRequested` | 用户从浮窗请求打开字幕设置 |

字幕浮窗参数：

```ts
type CaptionOverlayOptions = {
  fontSize: number
  color: string
  backgroundOpacity: number
  width: number
  height: number
  x: number | null
  y: number | null
}
```

主进程会限制范围：

- `fontSize`: 12 到 48
- `backgroundOpacity`: 0 到 1
- `width`: 320 到 1200
- `height`: 96 到 500
- `x/y`: 限制在主显示器工作区内

## 8. 渲染进程状态模型

全局状态在 `src/store/useASRStore.ts`。

### 8.1 页面与状态枚举

```ts
type AppPage = 'transcribe' | 'history' | 'models' | 'settings'
type TranscribeStatus = 'idle' | 'uploading' | 'processing' | 'polling' | 'done' | 'error' | 'cancelled'
type ServerStatus = 'connected' | 'disconnected' | 'checking'
type RecordStatus = 'idle' | 'recording' | 'processing'
type TriggerType = 'keyboard' | 'mouse'
type InputSource = 'file' | 'speaker'
type LiveCaptionStatus = 'idle' | 'listening' | 'transcribing' | 'error'
```

### 8.2 默认设置

当前 `DEFAULT_SETTINGS` 关键值：

```ts
serverUrl: 'http://10.154.39.91:8001'
defaultEngine: 'fireredasr2'
selectedEngines: ['fireredasr2']
defaultLanguage: 'zh'
whisperModel: 'base'
enablePunctuation: false
enableDiarize: false
multiEngine: false
mergeStrategy: 'first'
theme: 'windows'
inputSource: 'file'
liveCaptionEnabled: false
showDesktopCaptions: true
liveCaptionChunkSec: 4
captionFontSize: 20
captionFontColor: '#ffffff'
captionBackgroundOpacity: 0.86
captionBoxWidth: 760
captionBoxHeight: 150
triggerType: 'mouse'
triggerKey: 'mouse_middle'
injectMode: 'inject'
timeoutSec: 60
allowServerDataCollection: false
archiveDir: ''
```

### 8.3 持久化

Zustand persist 配置：

```ts
name: 'asr-desktop-store'
version: 11
partialize: (s) => ({ settings: s.settings, history: s.history })
```

因此只有：

- `settings`
- `history`

会持久化到浏览器 localStorage。迁移逻辑会规范化旧版本设置、引擎选择、字幕参数和归档目录。

历史记录最多保留 200 条。

## 9. 后端 API 契约

客户端封装在 `src/services/api.ts`。

### 9.1 健康检查

```http
GET /v1/health
```

期望返回：

```ts
{
  status: string
  uptime_sec: number
}
```

`App.tsx` 每 10 秒轮询一次，用于更新侧边栏服务状态。

### 9.2 转写

```http
POST /v1/transcribe
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 内容 |
|---|---|
| `file` | 音频 Blob/File |
| `options` | JSON 字符串 |

`options` 类型：

```ts
{
  engines: string[]
  language?: string
  whisper_model?: string
  whisper_task?: 'transcribe' | 'translate'
  enable_punctuation?: boolean
  enable_diarize?: boolean
  merge_strategy?: 'first' | 'vote' | 'concat'
  allow_server_data_collection?: boolean
  archive_dir?: string
}
```

同步成功返回 `TranscribeResponse`：

```ts
{
  task_id: string
  status: string
  full_text: string
  segments: Segment[]
  language: string | null
  engine_used: string
  confidence: number | null
  duration_sec: number | null
  elapsed_sec: number | null
  timing?: Record<string, unknown> | null
  client_timing?: Record<string, unknown> | null
  engine_results?: EngineResult[] | null
}
```

异步返回 `AsyncResponse`：

```ts
{
  task_id: string
  status: string
  message: string
  timing?: Record<string, unknown> | null
}
```

前端通过是否存在 `message` 字段判断是否进入轮询。

### 9.3 任务轮询

```http
GET /v1/tasks/{task_id}
```

终态集合：

```ts
success
failed
cancelled
```

轮询间隔默认 1500 ms，普通转写在 `Transcribe.tsx` 中使用 1000 ms。超时由 `settings.timeoutSec` 控制，0 表示使用长超时。

取消：

```http
POST /v1/tasks/{task_id}/cancel
```

### 9.4 模型管理

```http
GET /v1/models
POST /v1/models/{engine}/load
POST /v1/models/{engine}/unload
```

模型项类型：

```ts
{
  engine: string
  model_name: string
  is_loaded: boolean
  device: string | null
  compute_type: string | null
  languages: string[]
  extra: Record<string, unknown>
}
```

当前前端内置引擎：

```text
whisper
vosk
sherpa
fireredasr2
wenet
```

`Models.tsx` 中可配置加载参数的引擎：

```text
whisper
fireredasr2
wenet
```

默认加载参数：

```ts
whisper: {
  model_name: 'base',
  device: 'cuda',
  compute_type: 'int8'
}

fireredasr2: {
  model_name: 'FireRedASR2-AED',
  device: 'cuda'
}

wenet: {
  model_name: 'FireRed-Wenet-1B',
  device: 'cuda',
  extra: {
    decode_mode: 'ctc_greedy_search',
    dtype: 'fp32',
    is_1b: true
  }
}
```

## 10. 核心业务流程

### 10.1 文件转写

```text
DropZone
  -> openAudioDialog 或拖拽 File
  -> readFileBase64/fileInfo 转成本地 FileWithPath
  -> TranscribePage.handleFiles()
  -> runTranscription(blob, filename, null, false)
  -> api.transcribe()
  -> 同步结果或异步 pollTask()
  -> setCurrentResult()
  -> addHistory()
  -> archiveLocalTranscription()
  -> textToClipboard()
```

拖拽文件支持浏览器直接提供的 `File`。通过系统文件选择器返回的是路径，需要经 `fileInfo` 和 `readFileBase64` 转换为 Blob/File。

### 10.2 麦克风录音转写

```text
RecordButton 或全局触发键
  -> AudioRecorder.start()
  -> MediaRecorder 收集 audio/webm 或 audio/ogg
  -> 再次触发
  -> AudioRecorder.stop()
  -> runTranscription(blob, generatedName, duration, autoInject)
  -> 识别结果复制或注入
```

录音参数：

- 优先 MIME：`audio/webm;codecs=opus`
- 备选：`audio/webm`
- 再备选：`audio/ogg`
- 请求采样率：16000
- 开启 echoCancellation 与 noiseSuppression

### 10.3 实时字幕

```text
TranscribePage.toggleLiveCaption()
  -> AudioSegmentStreamer(source='speaker')
  -> getDisplayMedia 捕获扬声器 loopback
  -> 每 liveCaptionChunkSec 秒生成一个 Blob
  -> liveQueueRef 入队，最多保留 3 个待处理片段
  -> api.transcribe(live_caption_N.webm)
  -> 追加 full_text 和 segments
  -> showCaptionOverlay()
  -> 停止时保存一条历史记录
```

默认切片长度为 4 秒，可在 2 到 15 秒之间设置。

实时字幕和普通录音/转写互斥：

- 普通录音或转写中不能启动实时字幕。
- 实时字幕运行中不能开始普通录音。

### 10.4 多引擎识别

选中引擎来自：

```text
settings.selectedEngines
```

如果 `models` 中存在已加载模型，则只使用已加载引擎和已选择引擎的交集。没有模型状态时使用配置值。

多引擎结果展示：

- `engine_results` 存在时，`ResultPanel` 会按引擎拆分展示。
- 主结果仍使用 `full_text`、`segments`。

合并策略来自：

```text
settings.mergeStrategy: first | vote | concat
```

### 10.5 结果保存

每次普通转写成功后：

1. 写入 Zustand history。
2. 调用 `archiveTranscription()` 本地归档音频和 JSON。
3. 根据 `injectMode` 复制或自动注入文本。

归档目录：

- 如果 `settings.archiveDir` 为空，使用 `electronAPI.getDefaultArchiveDir()`。
- 默认目录为 `app.getPath('userData')/archive`。

JSON 归档内容包含：

```text
archived_at
task_id
filename
full_text
segments
language
engine_used
confidence
duration_sec
elapsed_sec
timing
client_timing
engine_results
```

## 11. 页面与组件职责

### 11.1 页面

| 页面 | 文件 | 职责 |
|---|---|---|
| 转写 | `src/pages/Transcribe.tsx` | 文件、录音、实时字幕、识别提交、历史写入、归档、注入。 |
| 历史 | `src/pages/History.tsx` | 展示本地历史，支持查看、复制、TXT/SRT 导出、删除、清空。 |
| 模型 | `src/pages/Models.tsx` | 获取模型列表，加载/卸载模型，配置默认识别引擎和语言。 |
| 设置 | `src/pages/Settings.tsx` | 后端地址、音频设备、字幕样式、触发键、主题、数据目录。 |

### 11.2 组件

| 组件 | 职责 |
|---|---|
| `TitleBar` | 自定义无边框窗口标题栏和窗口按钮。 |
| `Sidebar` | 页面导航和服务器连接状态。 |
| `Toolbar` | 引擎、语言、标点、多引擎、取消识别等快捷控制。 |
| `DropZone` | 文件拖拽、点击选择音频、读取本地路径文件。 |
| `RecordButton` | 录音按钮状态展示。 |
| `ResultPanel` | 文本、分段、JSON 三种结果视图和导出操作。 |
| `SegmentList` | 分段文本、时间戳、说话人、置信度展示。 |
| `TriggerCapture` | 捕获键盘或鼠标触发键。 |
| `HotkeyCapture` | 捕获键盘快捷键。 |
| `MenuBar` | 应用内菜单操作。 |
| `StatusBar` | 状态栏信息展示。 |
| `TabBar` | 标签式页面切换组件。 |

## 12. 样式与平台差异

入口 `src/main.tsx` 按平台动态导入样式：

```ts
if (navigator.userAgent.includes('Windows')) {
  import('./styles/global.css')
} else {
  import('./styles/mac.css')
}
```

Windows 布局：

- `App.tsx` 使用 `win11-body`。
- 自定义 title bar。
- 主进程启用托盘、状态浮窗、字幕浮窗、鼠标 hook、文本注入。

macOS/其他平台：

- 加载 `mac.css`。
- 部分 Electron 系统能力降级，例如文本注入只写剪贴板，状态/字幕浮窗只在 Windows 分支显示。

## 13. 安全边界

当前安全模型：

- `nodeIntegration: false`
- `contextIsolation: true`
- 渲染进程通过 preload 调用白名单 API。
- 主窗口 `sandbox: false`，浮窗 `sandbox: true`。
- `index.html` 配置 CSP，限制脚本、样式和连接地址。

注意事项：

- 如果新增后端域名，必须更新 CSP `connect-src`。
- 如果新增系统能力，必须同时更新 `preload.ts` 类型声明和 `src/vite-env.d.ts`。
- `shell.openExternal(url)` 当前直接打开传入 URL，调用方应只传可信地址。

## 14. 常见问题排查

### 14.1 `npm run dev` 后 Electron 没启动

检查：

- 5173 端口是否被占用。
- Vite 是否能打开 `http://localhost:5173`。
- `tsc -b tsconfig.node.json --force` 是否编译失败。

### 14.2 页面能打开但显示后端断开

检查：

- 后端 `/v1/health` 是否可访问。
- 设置页后端地址是否正确。
- `index.html` CSP 是否允许该地址。

### 14.3 实时字幕无法捕获扬声器

检查：

- 是否在 Windows 上运行。
- 系统是否正在播放声音。
- Electron 主进程是否执行了 `configureDisplayMediaCapture()`。
- 是否允许屏幕/音频捕获。

### 14.4 自动输入无效

当前自动输入依赖 Windows 剪贴板 + PowerShell SendKeys：

- ASR 主窗口聚焦时不会自动粘贴到自己。
- 目标应用必须有输入框聚焦。
- 非 Windows 平台只写剪贴板。

### 14.5 打包失败找不到图标

`electron-builder.yml` 引用了 `build/icon.ico`、`build/icon.icns`、`build/icon.png`。补齐图标，或临时移除对应 `icon` 配置。

### 14.6 修改后端 IP 后仍请求失败

同时检查：

- 设置页 `serverUrl`。
- `src/store/useASRStore.ts` 默认值。
- `src/services/api.ts` 默认值。
- `index.html` CSP 的 `connect-src`。

## 15. 复现验收清单

按以下清单验证桌面端是否完整复现：

1. `npm install` 或 `npm ci` 成功。
2. `npm run dev` 能启动 Electron 主窗口。
3. 设置页测试后端连接成功。
4. 模型页能列出后端引擎。
5. 至少一个引擎可加载，并能设为默认。
6. 文件拖拽或选择音频后能得到转写结果。
7. 麦克风录音开始、停止、转写正常。
8. Windows 上鼠标中键或配置的触发键能开始/停止录音。
9. 识别结果能复制到剪贴板或自动注入当前输入框。
10. 历史页能查看、复制、导出 TXT/SRT。
11. 本地归档目录中生成音频和 JSON。
12. Windows 上实时字幕能显示桌面字幕浮窗。
13. `npm run build:win` 能输出 `release/` 安装包。

## 16. 需要纳入版本控制的源码

应保留：

```text
frontend/desktop/electron/
frontend/desktop/scripts/
frontend/desktop/src/
frontend/desktop/index.html
frontend/desktop/package.json
frontend/desktop/package-lock.json
frontend/desktop/vite.config.ts
frontend/desktop/tsconfig.json
frontend/desktop/tsconfig.node.json
frontend/desktop/electron-builder.yml
```

不应保留：

```text
frontend/desktop/node_modules/
frontend/desktop/dist/
frontend/desktop/dist-electron/
frontend/desktop/release/
frontend/desktop/tsconfig.node.tsbuildinfo
```

如需复现安装包图标，还应保留 `electron-builder.yml` 中引用的图标资源，或将图标路径改到受版本控制的资源目录。
