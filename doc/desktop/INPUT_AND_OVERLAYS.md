# Amadeus 输入、浮窗与跨应用注入

> **父文档**: [← 返回桌面端总览](README.md)
> **相关文档**: [桌面语音识别](SPEECH_RECOGNITION.md) · [Higgs TTS 与变声器](TTS_VOICE.md)

## 麦克风预热与开头保护

Amadeus 在应用运行期间预热设置中选定的真实麦克风。预热流只负责提前完成操作系统设备打开；离线 ASR 和 TTS 一句话录音明确关闭浏览器 AEC、降噪和自动增益，保留实体麦克风原始波形。用户触发录音后，前端优先用 Web Audio 从已经存活的轨道采集连续 PCM 并封装为 WAV，`MediaRecorder` 仅作为兜底。若权限被拒绝或预热尚未完成，点击录音仍会直接请求麦克风并在轨道可用后立即开始录制，不额外等待固定的 1–2 秒。

AudioWorklet 为每个 PCM block 附带音频帧位置。renderer 会检测缺帧、重复块和重叠块：缺失区间补零以保持 WAV 的真实时间轴，重叠样本只保留一次，并输出诊断计数。该处理避免丢块后直接拼接前后波形造成时间压缩和爆音；它不会伪造已经丢失的语音，因此实体设备 E2E 仍要求 `gapSamples === 0`。

离线快捷录音、TTS 一句话录音和实时 ASR+TTS 始终独立打开设置中选定的实体麦克风；即使 relay 已启用，也不会克隆中转轨道或读取输出/虚拟声卡混音总线。实时字幕和 Agent 免按键识别仍可从 `AudioRelayMixer` 克隆其原始输入轨道，以维持现有全双工链路；这些模式不在本次 TTS 录音隔离变更范围内。

## 扬声器作为输入

设置页的“音频输入”可选择“扬声器（系统音频输出）”。Windows Electron 主进程只对 Amadeus 主窗口放行 `display-capture`/`media` 权限，并通过系统 loopback 轨道采集当前默认播放设备；视频轨道在取得流后立即关闭。该输入统一用于快捷离线识别、实时字幕、Agent 单次语音和 Agent 免按键识别。

“音频输入”与“音频输入来源”会同步更新，选择扬声器时不会再把 `__speaker_loopback__` 当成普通麦克风 deviceId。扬声器回环与虚拟麦克风中转互斥，以免把系统播放重新送回输出总线形成反馈。设置页“测试输入”在扬声器模式下应先播放一段系统声音，再显示实际 peak/RMS 结果；采集失败会直接显示系统音频错误，不静默回退到麦克风。

## 动态状态浮窗

普通录音状态浮窗位于主显示器水平居中、距屏幕底部约 28% 的位置，窗口不获取键盘焦点：

- 普通 recording/thinking/error 浮窗为 200×32。采集阶段由 renderer 中的 `AnalyserNode` 计算 peak/RMS，每次采样把新电平追加到 28 段历史队列；波形从左向右滚动，展示约一段短时间内的声音变化，而不是把同一个瞬时电平画成更粗的柱。文字只显示“语音输入中”，不根据瞬时低电平误报输入设备异常。
- 停止录音并提交后切换为 `thinking.`、`thinking..`、`thinking...` 循环动画。
- 当前焦点不能输入文本时，同一浮窗切换为识别结果，并启用“复制”和“×”按钮；复制会写入剪贴板并关闭浮窗，关闭只隐藏浮窗。
- 异常时可在 Amadeus 主界面点击“强制停止”；同一全局触发键在处理中再次按下也会执行强停。

强停会同时终止 MediaRecorder、前端 fetch/轮询、已知后端异步任务和实时 WebSocket，然后立即恢复可再次录音的状态。同步模型已进入底层推理调用时，前端请求会立即断开，但设备/模型运行时是否能抢占当前 GPU kernel 仍取决于具体引擎。

## 跨应用文本输入

自动输入遵循以下流程：

1. 录音浮窗显示前，renderer 调用 `text:captureTarget`，Windows 主进程记录当时的前台窗口句柄。ASR 最终文本一返回就先启动投递 promise，然后才更新历史、归档和 telemetry，避免“前端已收到结果但还没输入”的延迟。
2. 注入 helper 收到文本后先恢复录音前捕获的窗口，再通过 PowerShell 直接调用 UI Automation，检查当前焦点控件是否启用、可聚焦，并读取 `ValuePattern.IsReadOnly`；仅暴露 `ControlType.Edit` 的编辑器也按可输入处理。QQ、TIM、微信、VS Code、Cursor、Trae 等 Electron 自绘编辑器可能只暴露 Pane/Document，因此再按焦点元素所属进程启用受限兼容分支。其他无法确认的应用仍采用保守分支，不发送按键，也不提前覆盖剪贴板。
3. 焦点可编辑时才写入系统剪贴板，并通过常驻 STA helper 执行粘贴。普通应用使用 `SendInput` 发送标准 Ctrl+V；QQ、TIM、微信等聊天客户端如果把输入区暴露成非标准控件，会进入兼容分支并使用 `SendKeys` 粘贴。录音/Thinking 浮窗保持非聚焦，因此 VS Code/Codex 输入框、浏览器文本框等原前台控件仍是粘贴目标。
4. 粘贴成功后直接关闭 Thinking 浮窗，不创建结果框。只有焦点不可编辑、平台不支持或注入失败时，状态浮窗才显示完整识别结果；用户可点击“复制”后关闭，也可点击“×”直接关闭。

连续离线识别使用 latest-wins 注入调度：如果前一轮 UI Automation/helper 仍卡住，新结果会先取消旧注入并立即执行；尚未开始的中间项不会继续阻塞最新文本。Electron 主线程不再同步写剪贴板，避免与 STA helper 争用时冻结事件循环；helper 在应用启动时预热，ready 之前不启动单次注入计时。每个 pending 请求同时绑定其 PowerShell helper，已被替换的旧 helper 即使稍后触发 stdout、stderr 或 exit，也不能清理新请求。普通完成路径仍保持串行，避免剪贴板和 Ctrl+V 乱序。开发调试台会记录“识别响应接收”“自动回填开始”“自动回填完成”，可直接区分后端延迟和注入延迟。

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

Electron 当前最小窗口为 720×520。页面取消 1080px/760px 固定 body 最小宽度，并在 980px、760px 和 560px 高度断点重排侧栏、设置表单、识别底栏、弹窗、Agent 面板和历史列表。720×520 Electron 实测中 `documentElement.scrollWidth === innerWidth === 720`，内容区使用内部纵向滚动，不再出现整页横向挤压。

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
2. 720×520 最小主窗口无整页横向溢出。
3. 专用 textarea 中真实执行 Windows user32 Ctrl+V，读取输入值并截图；随后以 300 ms 间隔执行两次连续注入，要求第二次在 500 ms 内完成且 textarea 保留最新文本。
4. 录音波形、Thinking、识别结果和字幕浮窗截图，验证结果复制/关闭按钮与字幕设置/关闭按钮 IPC。
5. 直接调用生产 `AudioRelayMixer`：枚举 DJI MIC MINI、CABLE Input/Output，将 DJI 轨道常态连接到 `CABLE Input`，通过真实 `pushPcm16()` 叠加 997 Hz 测试音，再从 `CABLE Output` 采样 RMS/peak 证明 Cable 回环。

结果位于 `%TEMP%/amadeus-e2e-<时间>/userData/e2e/result.json`；任何子项失败时脚本退出码为 1，并保留截图和 `audio-relay.json`。

---

> 📖 [返回桌面端总览 →](README.md)
