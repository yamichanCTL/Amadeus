# Amadeus 录音、浮窗、输入注入与音频路由改造

> **父文档**: [← 返回计划索引](README.md)
> **相关文档**: [桌面语音识别](../desktop/SPEECH_RECOGNITION.md) · [Higgs TTS 与变声器](../desktop/TTS_VOICE.md)

## 任务目标

1. 消除点击录音后麦克风初始化造成的开头 1–2 秒不可用窗口，并以真实输入电平波形反馈采集状态。
2. 为录音、上传/轮询和实时识别提供统一、幂等的强制停止能力。
3. 让识别文本能可靠粘贴到 VS Code/Codex 输入框、浏览器文本框等当前前台应用。
4. 修复窗口缩小时的固定最小宽度、网格溢出和控件冲突，使页面按断点重排。
5. 将桌面产品用户可见品牌和安装包名称改为 Amadeus。
6. 将识别状态浮窗移到屏幕中下部：采集时显示随真实音量变化的波形，提交后显示动态 `thinking.` / `thinking..` / `thinking...`。
7. 简化实时识别为时间范围加文本的预览；字幕浮窗可关闭，并提供设置按钮打开应用设置页，尺寸、位置、字号、颜色和透明度可持久调节。
8. 把真实麦克风常态透传和 TTS/音效叠加统一到持久音频中转总线，支持将结果送到 VB-Audio Virtual Cable 播放端点。
9. 设置页新增用户 ID，并把值写入 Electron 应用数据目录的 `archive/userid`；识别归档使用同一 ID。

## 影响范围

- Electron 主进程与 preload：`frontend/desktop/electron/main.ts`、新增浮窗 preload、`frontend/desktop/src/vite-env.d.ts`。
- 录音/流式与混音：`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/services/api.ts`。
- 桌面状态与页面：`useASRStore.ts`、`App.tsx`、`Transcribe.tsx`、`Settings.tsx`、`VoiceChanger.tsx`、品牌组件。
- 响应式样式与构建信息：`global.css`、`index.html`、`package*.json`、`electron-builder.yml`。
- 后端归档：转写 options、实时 WebSocket config 和异步任务归档 ID 传递。
- 测试与文档：前后端定向测试、CHANGELOG、桌面专题文档和逐项测试报告。

## 实现步骤

1. 为 `AudioRecorder` 增加可复用的麦克风预热、启动就绪和音量回调；录音页面进入后预热，停止/取消后释放资源。
2. 在转写 API 加入 `AbortSignal`，页面统一持有当前控制器；强停同时取消录音、fetch、轮询、后端任务和 WebSocket，并立即恢复 UI。
3. 用 Windows `SendInput` 发送粘贴组合键，保留剪贴板内容并确保浮窗不抢焦点；非 Windows 明确降级为仅复制。
4. 重写状态浮窗为中下部非聚焦动态视图，使用 renderer 传来的真实 RMS/peak 驱动波形；thinking 点号由浮窗动画更新。
5. 为字幕浮窗增加专用 preload、关闭/设置按钮及 IPC，设置按钮唤醒主窗口并跳转设置页；修复关闭时实时流未停止的问题。
6. 简化实时预览结构和时间格式，并保证 partial 在缺少 `speech_start` 事件时仍创建/刷新最新条目。
7. 去除固定 body 最小宽度，降低 BrowserWindow 最小尺寸，补齐 980/760/560 断点下的侧栏、表单、网格、底栏和弹窗重排。
8. 将 `AudioRelayMixer` 提升为应用级单例并增加持久启用设置；设置页统一选择真实输入、虚拟输出、测试和启停，TTS/音效复用该总线。
9. 实现 `archive/userid` 读写 IPC，设置启动时双向同步，并把 user ID 传给文件/录音和实时归档。
10. 执行 TypeScript、Vite、Electron 主进程、Python、pytest、文档构建和 diff 检查，逐项记录通过/硬件受限证据。

### Windows 实机验收补充方案

WSL 已成功生成当前 `Amadeus.exe` 并在 Windows Session 3 启动，但 WSL 无法直接访问仅绑定 Windows loopback 的 DevTools 端口，且外部执行审批额度在查询阶段耗尽。为避免依赖跨环境端口或向用户当前编辑器误发按键，增加隔离的 `--amadeus-e2e` 启动模式：

1. 创建专用测试输入框并聚焦，只向该窗口执行真实 Windows Ctrl+V，验证剪贴板和 user32 注入结果。
2. 真实创建录音/Thinking 和字幕浮窗，捕获截图，点击字幕设置/关闭按钮并核对主窗口页面与窗口可见性。
3. 将主窗口缩到 580×500，直接读取 renderer 的 viewport/scrollWidth 验证响应式布局。
4. 在独立 media 测试窗口枚举 DJI MIC MINI、CABLE Input/Output，使用 `AudioContext.setSinkId()` 建立 DJI 常态透传和测试音叠加，再从 CABLE Output 采集 RMS 证明回环。
5. 结果和截图写入隔离 userData 的 `e2e/` 后自动退出，不修改用户实际 Amadeus 设置，不向 VS Code 或浏览器真实窗口发送测试文本。

## 风险评估

- 麦克风预热会在进入识别页面时请求权限；若用户拒绝，录音按钮仍会再次请求并显示明确错误。
- Windows 文本注入依赖当前前台控件接受标准 Ctrl+V；管理员权限隔离的高权限窗口不能由低权限应用注入，需明确提示。
- 物理麦克风透传到实体扬声器可能产生反馈；设置页必须提示 VB-Cable 应选择其播放端点（通常为 `CABLE Input`），系统默认麦克风选择录音端点（通常为 `CABLE Output`）。
- `AudioContext.setSinkId()` 和真实 VB-Audio 端点只能在 Windows Electron 实机完全验证；自动测试覆盖状态、设备选择和混音调度代码，硬件结论单列。
- 工作树包含大量用户已有修改；所有补丁保持增量，不回退、不格式化无关文件。

## 验证结果

- renderer TypeScript、Electron 主进程 TypeScript、Vite 生产构建、Python compileall：通过。
- 后端归档/流式定向测试：加入隔离 E2E 后最新 `6 passed in 0.23s`。
- electron-builder Linux unpacked 打包：通过，输出 `release/linux-unpacked`。
- 真实 Electron + DevTools：Amadeus title/品牌、preload API、`archive/userid` 写入读回通过；580×500 时页面总 scroll width 等于 viewport width。
- Windows PowerShell 对 user32 文本注入 P/Invoke 声明编译通过；PnP 只读检查确认 DJI MIC MINI、CABLE Input、CABLE Output 和 CABLE In 16ch 状态均为 `OK`。
- 已生成当前 `Amadeus.exe` Windows unpacked 构建并在 Windows Session 3 成功启动，主窗口标题为 `Amadeus`。为完成剩余实机测试，新增内置 `--amadeus-e2e` 模式和 PowerShell 启动器；当前轮外部执行审批额度在读取 Windows DevTools 端口时耗尽，因此最新 E2E 构建尚未重新复制/运行。
- Windows 前台真实粘贴、always-on-top 浮窗交互及 VB-Cable 实际回环属于目标桌面硬件验收，当前 WSL2/Xvfb 环境无法安全替代；详见[测试报告](../reports/2026-06-21-amadeus-desktop-capture-overlay-routing-test-report.md)。
