# 2026-06-24 修复自动注入/后端地址/浮窗拖动波形/录音页面切换卡死

## 目标

解决用户反馈的 5 个问题，且不破坏现有功能：

1. ASR 结束后，鼠标光标在输入框里却无法自动输入。
2. 后端地址：删掉前端记录的初始后端地址；用户设置并确认后才通信，未设置不进行任何通信。
3. thinking / 语音输入中小浮窗无法拖动换位置；波形会卡死不动；前端 UI 没打开或按键触发时不动。
4. 语音输入中切换到历史识别等页面，录音异常中断、切回后卡在异常 thinking；要求执行语音识别时不影响其他操作。
5. 修复要测试通过，且不影响其他功能。

## 影响范围

- `frontend/desktop/electron/main.ts` — injectText 焦点判定、status overlay 拖动、波形刷新、IPC。
- `frontend/desktop/electron/preload.ts` — 暴露新 IPC（setIgnoreMouseEvents、状态覆盖层拖动）。
- `frontend/desktop/electron/status-overlay-preload.ts` — 暴露拖动相关 API。
- `frontend/desktop/electron/e2e.ts` — 不破坏现有断言（200×32、居中、复制、关闭）。
- `frontend/desktop/src/services/api.ts` — `normalizeServerUrl`：空地址不再回退 localhost:8000。
- `frontend/desktop/src/services/audio.ts` — `buildWsUrl`/`buildWsUrlCandidates`：空地址不再回退 ws://localhost:8000；`startLevelMonitor` 用 setInterval 替代 RAF，避免后台窗口节流导致波形卡死。
- `frontend/desktop/src/services/liveCaption.ts` — start 前校验 serverUrl 非空。
- `frontend/desktop/src/services/recordingService.ts`（新增）— 录音编排单例，跨页面存活。
- `frontend/desktop/src/pages/Transcribe.tsx` — 改为调用 recordingService；卸载不再 cancel 进行中的录音；修复 stop 抛错卡 thinking。
- `frontend/desktop/src/App.tsx` — 全局热键直接走 recordingService，跨页面可用。
- `frontend/desktop/src/pages/Settings.tsx` — 后端地址改为「草稿 + 确认」交互，未确认不持久化、不通信。
- `frontend/desktop/src/store/useASRStore.ts` — 移除 localhost:8000 迁移回退残留注释；确认 serverUrl 默认空。

## 实现步骤

### 问题 1：自动注入失败

根因：`injectText`（main.ts:729）焦点判定 `IsKeyboardFocusable` 为 false 时直接 `exit 3`，**绕过**了下方 Document/Pane/Group/Custom 富文本启发式判定，导致 QQ/VSCode/浏览器 contenteditable 等编辑器被判为「不可编辑」而拒绝注入，前端转而弹结果浮窗。

修复：
- 放宽焦点判定：`IsKeyboardFocusable` 不再作为硬性早退条件；仅当 `focused` 为 null 或 `IsEnabled=false` 时早退。把 `IsKeyboardFocusable` 作为软信号参与启发式，而非拦截。
- 焦点不确定时仍尝试注入（剪贴板 + WM_PASTE + Ctrl+V），失败才退出。用户已明确光标在输入框，放宽利大于弊。
- 增加 stderr 诊断日志输出 phase/exit code，便于排查。

### 问题 2：后端地址未确认不通信

根因：
- `normalizeServerUrl`（api.ts:422）在 Electron `file:/app:` 协议下空地址回退 `http://localhost:8000`。
- `buildWsUrl`（audio.ts:677）同样回退 `ws://localhost:8000`。
- Settings 后端地址输入即写入 `settings.serverUrl` 立即生效，无确认环节。

修复：
- `normalizeServerUrl`：空 / `/` 一律返回 `''`，不再回退 localhost。REST 调用同源或失败，不自动连本机。
- `buildWsUrl` / `buildWsUrlCandidates`：空地址返回空串 / 空数组；WS 客户端在空地址时抛出「请先在设置中确认后端地址」而不是连本机。
- `liveCaptionService.start()`：serverUrl 为空时 setLiveCaptionStatus('error') 并 setError 提示，不连 WS。
- `Settings.tsx`：后端地址改为本地草稿态 `draftServerUrl`，输入只改草稿；点「确认」按钮校验格式后 `updateSettings({ serverUrl: draft })`；显示当前已确认地址与连接状态；未确认时通信层拿到的是旧的（或空）serverUrl，不连新地址。
- 保留 App.tsx 健康检查空地址跳过逻辑。

### 问题 3：浮窗拖动 + 波形卡死

拖动根因：status overlay `movable: false`（main.ts:310）+ 录音/thinking 时 `setIgnoreMouseEvents(true)`（477），鼠标事件完全穿透，无法拖动。

修复（Electron 标准 click-through + 拖动模式）：
- status overlay 创建时 `movable: true`。
- 录音/thinking 阶段改为 `setIgnoreMouseEvents(true, { forward: true })`，转发 mousemove 以检测悬停，点击穿透。
- 状态浮窗 HTML 增加一个拖动手柄区（`.drag-handle`，`-webkit-app-region: drag`）；监听 mousemove，悬停到手柄区时经 IPC `statusOverlay:setIgnoreMouseEvents(false)` 接管鼠标（配合 `-webkit-app-region: drag` 原生拖动），离开时恢复 `setIgnoreMouseEvents(true, { forward: true })`。
- result 阶段保持 `setIgnoreMouseEvents(false)`，按钮可用。
- 新增 IPC `statusOverlay:setIgnoreMouseEvents(ignore: boolean, forward?: boolean)`。
- 拖动后位置持久化到 settings（statusOverlayX/Y），下次显示沿用；首次仍居中。

波形卡死根因：`startLevelMonitor` 用 `requestAnimationFrame`，主窗口被最小化/后台/页面切走时 RAF 被节流甚至暂停，level 不再上报 → 浮窗波形冻结。「UI 没打开/按键触发时不动」同理。

修复：
- `startLevelMonitor` 改用 `setInterval(update, 60)`（后台也持续触发，虽可能被降到 ~1s 但不冻结），并在 stop 时 `clearInterval`。AudioContext 已 `resume()`。
- 移除 Transcribe onLevel 70ms 节流的「首次跳过」隐患：初始化 `levelUpdateAtRef` 为 0 时首次 now-0 一定 > 70（performance.now 从页面加载起算），保留节流但确保首次能上报。
- 录音单例化（问题 4）后，level 上报来自单例而非页面，页面切走也不停。

### 问题 4：录音与页面解耦，不卡 thinking

根因：
- Transcribe 卸载 cleanup（64-74）无条件 `speechRecorder.cancel()` + `abort()`，打断进行中的录音/识别。
- 全局热键 `amadeus:toggle-recording` 监听注册在 Transcribe（91-102），卸载即失效，切页面后无法用热键停止。
- stop 路径（308-319）`await recorderRef.current.stop()` 若抛错（已被 cancel），`runTranscription` 不执行 → `hideStatusOverlay` 不调用 → 卡在 thinking。

修复（小步重构，符合 CLAUDE.md「模块职责清晰、组件解耦」）：
- 新增 `services/recordingService.ts` 单例（参照 `liveCaptionService` 模式），持有 `speechRecorder`、当前 `AbortController`、`toggle(autoInject)`、`forceStop()`、`runTranscription()`、`persistResult()`、level 上报。所有状态走 useASRStore 全局 setter，overlay 走 IPC。
- `TranscribePage` 改为薄视图：按钮调用 `recordingService.toggle()/forceStop()`；卸载 cleanup 不再 cancel 进行中的录音（仅清理本地 UI ref），录音跨页面存活。
- `App.tsx` 注册全局 `amadeus:toggle-recording` → `recordingService.toggle(true)`，跨页面可用；移除 Transcribe 内的同名监听。
- stop 路径用 try/catch/finally 包裹，`stop()` 抛错时 catch 内 `hideStatusOverlay()` + setError + setRecordStatus('idle')，绝不卡 thinking。
- `runTranscription` finally 兜底 `hideStatusOverlay()`（除非 persistResult 已显示 result 浮窗）。
- 与 liveCaption 互斥沿用 store 状态判断（单例内读 useASRStore.getState()）。

### 问题 5：测试不破坏其他功能

- 类型：`cd frontend/desktop && npx tsc --noEmit`（若 tsconfig 允许）+ `vite build` 跑通。
- 后端：`python -m pytest`（testpaths 含 backend/tests）。
- Electron E2E（`--amadeus-e2e`）断言不破坏：status overlay 200×32、居中、复制、关闭、inject。Linux/WSL 无法跑 GUI E2E（overlay/inject 仅 Windows），以 tsc + pytest + 代码审查保证；Windows 端可后续手动跑 E2E。

## 风险

- recordingService 单例化是中等重构，需保证 liveCaption/forceStop/telemetry 调用链不丢。
- 浮窗拖动改 `movable: true` + forward 鼠标事件，需确保 result 按钮仍可点、E2E 断言不破。
- buildWsUrl 去掉 localhost 回退后，开发态 Vite 代理同源仍可用（serverUrl 空 → 同源），不影响本地开发。
- Settings 草稿态需处理「用户清空后确认」→ serverUrl 空 → 不通信，符合需求。

## 验证

- `cd frontend/desktop && npx tsc --noEmit -p tsconfig.json` 与 `npx tsc --noEmit -p tsconfig.node.json`
- `cd /home/yami/AI/asrapp && python -m pytest -q`
- 代码审查：inject 放宽、后端空地址不通信、浮窗拖动、录音单例。
