# Amadeus 桌面输入、浮窗与音频路由测试报告

> **父文档**: [← 返回桌面端总览](../desktop/README.md)
> **相关计划**: [Amadeus 录音、浮窗、输入注入与音频路由改造](../plans/2026-06-21-amadeus-capture-overlay-routing-userid.md)

## 验证环境

- 代码与 Linux Electron：WSL2，Electron 31.7.7，Xvfb，Node/TypeScript/Vite。
- Windows 主机只读检查：Windows PowerShell、PnP AudioEndpoint。
- 当前自动化环境没有可交互的 Windows Electron 桌面会话，不能安全向用户当前前台窗口实际发送 Ctrl+V，也不能在 Chromium Windows 音频栈内完成 VB-Cable 录放回环。

## 逐项结果

| # | 需求 | 当前证据 | 结论 |
|---|---|---|---|
| 1 | 录音开头 1–2 秒 | 应用级 `speechRecorder.prepare()` 提前打开真实麦克风；触发后复用 live track，未预热时也不再人为等待；100 ms timeslice；renderer 类型检查和 Electron 启动通过 | 代码通路通过；真实 DJI 语音 onset 仍需 Windows 实录 |
| 2 | 异常强制停止 | 强停统一执行 recorder cancel、AbortController、后端 task cancel、WebSocket stop 和 UI reset；处理中再次按全局触发键也会强停 | 实现与编译通过；底层 GPU kernel 是否可抢占由模型引擎决定 |
| 3 | VS Code/Codex/浏览器自动输入 | Electron IPC API 存在；先写剪贴板，Windows 通过 user32 Ctrl+V；Windows PowerShell `Add-Type` 对同一 P/Invoke 声明编译成功 | 桥接语法通过；为避免污染用户当前前台窗口，未执行真实粘贴 |
| 4 | UI 等比例收缩 | 真实 Electron 经 DevTools 调整到 580×500：`innerWidth=580`、`documentElement.scrollWidth=580`、`body.scrollWidth=580`，侧栏/内容列为 `66px 514px` | 通过，无整页横向溢出 |
| 5 | 软件改名 Amadeus | Electron 页面 title=`Amadeus`、品牌 DOM=`Amadeus`；安装包 `productName: Amadeus`；Linux unpacked 打包通过 | 通过 |
| 6 | 中下部动态录音/thinking 浮窗 | 主进程窗口位置为水平居中、屏高 72%；renderer 实时电平 IPC、波形和 thinking 三态已通过 Electron 主进程编译 | Linux 构建通过；Windows always-on-top 视觉需实机确认 |
| 7 | 实时预览与字幕框 | partial 缺少 speech_start 时补建条目；预览只保留 `HH:mm:ss → HH:mm:ss` 和文本；字幕独立 preload、关闭/设置 IPC、动态 store 设置均通过类型/打包检查 | 代码通路通过；Windows 字幕按钮点击需实机确认 |
| 8 | DJI 常态透传 + TTS/音效叠加到 Cable | `AudioRelayMixer` 升级为应用级单例，设置持久化；Voice/Agent 服务端 TTS 和音效进入同一 destination。Windows PnP 实查 DJI MIC MINI、CABLE Input、CABLE Output、CABLE In 16ch 均为 `OK` | 设备存在且实现通过；真实 Cable 回环音质/电平需 Windows Electron 验收 |
| 9 | 用户 ID 保存到 `archive/userid` | Electron IPC 实际写入并读回 `amadeus-smoke-user`，路径为 `/tmp/.../Amadeus/archive/userid`；后端归档定向测试验证 user ID 进入目录和 JSON | 通过 |

## 自动化命令

```text
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit
node node_modules/vite/bin/vite.js build
node node_modules/electron-builder/out/cli/cli.js --linux dir
.venv/bin/python -m compileall -q backend/app backend/tests
.venv/bin/python -m pytest backend/tests/test_amadeus_desktop.py backend/tests/test_streaming_session.py -q
```

结果：TypeScript、Electron 主进程、Vite 和 Linux unpacked 打包全部通过；加入隔离 E2E 后最新 pytest `6 passed in 0.23s`。包含完整 `test_api.py` 的组合运行在已有 API fixture 阶段完成 4 项后继续无输出挂起，已中止，不将其计为通过或本次源码失败。

## Electron 端到端烟雾测试

Xvfb 中启动生产构建并通过 DevTools 协议执行 preload IPC：

```json
{
  "title": "Amadeus",
  "brand": "Amadeus",
  "hasInject": true,
  "hasCaption": true,
  "saved": {
    "userId": "amadeus-smoke-user",
    "path": "/tmp/amadeus-electron-e2e/Amadeus/archive/userid"
  },
  "read": "amadeus-smoke-user"
}
```

## Windows 实机剩余验收

1. 在设置中选择 DJI MIC MINI；虚拟输出选择 `CABLE Input`；Windows 默认麦克风选择 `CABLE Output`。
2. 启用中转，用系统录音机录 10 秒：前 5 秒只说话，后 5 秒播放一条 TTS；应同时听到连续人声和叠加 TTS，无开头丢字。
3. 分别聚焦 VS Code Codex 提问框和浏览器 textarea，按右 Alt 开始/停止；确认识别文本进入原控件。
4. 启动实时识别，点击字幕 `×` 确认只隐藏字幕且页面预览继续；再开启字幕，点击 `⚙` 确认进入设置页并实时调整宽高/透明度。

### 自动验收入口

上述交互已封装为隔离 `--amadeus-e2e` 模式，使用专用输入框和临时 userData，避免污染当前 VS Code/Codex：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/run_amadeus_windows_e2e.ps1
```

当前 Windows PnP 设备和交互式 Session 3 已确认，当前 `Amadeus.exe` 也已成功启动。最新 E2E 构建生成后，外部执行审批额度在 DevTools 查询阶段耗尽，因而本报告仍保留这四项为“待运行结果”，不将测试工具本身等同于实机通过。

---

> 📖 [返回桌面端总览 →](../desktop/README.md)
