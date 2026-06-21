# Amadeus 输入、浮窗与跨应用注入

> **父文档**: [← 返回桌面端总览](README.md)
> **相关文档**: [桌面语音识别](SPEECH_RECOGNITION.md) · [Higgs TTS 与变声器](TTS_VOICE.md)

## 麦克风预热与开头保护

Amadeus 在应用运行期间预热设置中选定的真实麦克风。预热流只负责提前完成操作系统设备打开、AEC 和降噪初始化；用户触发录音后，`MediaRecorder` 立即接管已经存活的轨道并以 100 ms timeslice 收集数据。若权限被拒绝或预热尚未完成，点击录音仍会直接请求麦克风并在轨道可用后立即开始录制，不额外等待固定的 1–2 秒。

启用应用级音频中转时不再额外打开预热流。录音、实时字幕和 Agent 免按键识别从 `AudioRelayMixer` 克隆轨道，物理麦克风仍只由中转总线持有一次。

## 动态状态浮窗

普通录音状态浮窗位于主显示器水平居中、距屏幕底部约 28% 的位置，窗口不获取键盘焦点：

- 采集阶段由 renderer 中的 `AnalyserNode` 计算 peak/RMS，每 70 ms 更新七段波形；低电平时明确提示检查输入设备。
- 停止录音并提交后切换为 `thinking.`、`thinking..`、`thinking...` 循环动画。
- 异常时可在 Amadeus 主界面点击“强制停止”；同一全局触发键在处理中再次按下也会执行强停。

强停会同时终止 MediaRecorder、前端 fetch/轮询、已知后端异步任务和实时 WebSocket，然后立即恢复可再次录音的状态。同步模型已进入底层推理调用时，前端请求会立即断开，但设备/模型运行时是否能抢占当前 GPU kernel 仍取决于具体引擎。

## 跨应用文本输入

自动输入遵循以下流程：

1. 识别结果先写入系统剪贴板，确保任何失败都保留可手动粘贴的文本。
2. Windows 主进程等待 90 ms，通过 `user32.dll` 的键盘事件发送标准 Ctrl+V；状态浮窗保持非聚焦，因此 VS Code/Codex 输入框、浏览器文本框等原前台控件仍是粘贴目标。
3. 注入失败或超时会在 Amadeus 显示错误，并保留剪贴板内容。非 Windows 平台明确降级为复制。

Windows 不允许低权限进程向管理员权限窗口注入输入；如果目标 VS Code/浏览器以管理员身份运行，Amadeus 也必须处于相同权限级别，或改用“复制到剪贴板”。

## 实时识别预览与字幕框

实时预览只显示时间范围和文本，例如：

```text
20:12:41  → 20:13:24
好啊
```

页面不再重复显示日期、“识别结果”“实时识别”等标签。即使后端在 `speech_start` 前先返回 partial，前端也会创建当前条目并持续覆盖为最新结果，避免预览停留在旧文本。

桌面字幕框使用独立 preload，并提供右上角两个按钮：

- `×`：只隐藏字幕框并关闭“显示桌面字幕框”设置，不中断实时识别；页面内预览继续更新。
- `⚙`：唤醒 Amadeus 主窗口并进入设置页。

设置页可实时调整是否显示、字号、颜色、透明度、宽度、高度和默认位置；拖动/缩放字幕框产生的 bounds 仍会持久化。

## 响应式窗口

Electron 最小窗口从 800×560 调整为 560×460。页面取消 1080px/760px 固定 body 最小宽度，并在 980px、760px 和 560px 高度断点重排侧栏、设置表单、识别底栏、弹窗、Agent 面板和历史列表。580×500 Electron 实测中 `documentElement.scrollWidth === innerWidth === 580`，内容区使用内部纵向滚动，不再出现整页横向挤压。

## 用户 ID

设置页的“用户 ID”同时用于本地识别归档、实时 WebSocket 归档和被动总结筛选。Electron 主进程将清理后的值保存为：

```text
<Electron userData>/archive/userid
```

保留旧的 `asr-desktop-store` Zustand key 和 `com.asrapp.desktop` appId 是有意的兼容策略：软件用户可见名称和安装包已经改为 Amadeus，但升级不会丢失原有设置与应用数据。

## Windows 隔离端到端验收

Windows unpacked 构建支持 `--amadeus-e2e`。该模式使用隔离 userData 和专用测试窗口，不会向当前 VS Code、Codex 或浏览器误发文字；测试结束自动写出 JSON、截图并退出。仓库提供一键脚本：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/run_amadeus_windows_e2e.ps1
```

脚本会复制 `release/win-unpacked` 到 Windows `%TEMP%`，依次验证：

1. Amadeus 品牌和 `archive/userid` 实际读写。
2. 580×500 主窗口无整页横向溢出。
3. 专用 textarea 中真实执行 Windows user32 Ctrl+V，读取输入值并截图。
4. 录音波形、Thinking、字幕浮窗截图，字幕设置和关闭按钮 IPC。
5. 直接调用生产 `AudioRelayMixer`：枚举 DJI MIC MINI、CABLE Input/Output，将 DJI 轨道常态连接到 `CABLE Input`，通过真实 `pushPcm16()` 叠加 997 Hz 测试音，再从 `CABLE Output` 采样 RMS/peak 证明 Cable 回环。

结果位于 `%TEMP%/amadeus-e2e-<时间>/userData/e2e/result.json`；任何子项失败时脚本退出码为 1，并保留截图和 `audio-relay.json`。

---

> 📖 [返回桌面端总览 →](README.md)
