# Amadeus 实时语音

更新：2026-09-26。

Windows 公开版已增加 [一键安装与启动](windows-quick-start.md) 和 [模型下载](model-downloads.md)。下述目录启动命令保留给源码开发；普通用户可安装 Release 后在设置中启动本机环境。角色模型改为本地导入，公开安装包不附带第三方 GLB。

## Windows 启动与配置

已经生成可运行目录：`frontend/desktop/release-integrated/win-unpacked/Amadeus.exe`。

在项目根目录运行：

```powershell
.\scripts\start_amadeus_desktop.ps1 -SkipBuild
```

此命令启动本机 FastAPI 后端和已构建的 Windows 应用。首次构建或修改源码后，退出该桌面窗口，再运行不带 `-SkipBuild` 的命令。原有 `release`、`release-ready` 保留。

1. 设置 → 常规 → 后端地址填写 `http://127.0.0.1:8000`，点击确认。
2. 实时对话 → 实时语音模型，选择模型和音色。音色按女声、男声、性别未核实分组。
3. 千问可选择“千问 3.7 Plus”作为复杂任务大脑；Gemini 深度思考可选择思考强度。
4. 点击“开始全双工”。结束当前会话后可切换模型、音色，再连接。
5. “服务商密钥与百炼配置”可保存本机 API Key；输入框留空保留已有值。密钥只写入被 Git 忽略的 `backend/.env`，不返回前端、不存入浏览器持久化设置。

输入和输出设备沿用“设置 → 音频”。会话的角色提示词、长期记忆采用实时对话页面配置。切换模型会建立新的会话，页面保留的旧字幕不会自动成为新模型的记忆。

## 已整合模型

| 模型 | 本机状态 | 可用配置 |
| --- | --- | --- |
| Qwen Audio 3.1 Realtime Plus | 已连接实测 | 13 音色、可选 Qwen 3.7 Plus 大脑 |
| Gemini 3.8 Live | 已连接实测 | 30 音色 |
| Gemini 3.8 Live Extended Thinking | 已连接实测 | 30 音色、低/中/高思考强度 |
| Higgs Realtime | 已连接实测；此前对话质量评价较差 | 6 音色 |
| Grok Voice Think Fast 2.0 | 适配器保留；当前免费额度限制禁止 API 会话 | 28 音色，官方目录未核实性别 |
| GPT Live | 保留后续部署入口，未完成本次部署或实测 | 未配置密钥时不可连接 |

“可以连接”表示本地配置通过检查，不保证服务商账户有余额或剩余免费额度。没有新增付费授权开关；Grok 继续遵守现有免费额度限制。

## 交互与工具边界

- 采集持续运行：16 kHz PCM 输入，24 kHz PCM 输出。使用模型原生语音打断，不按本机单个音量脉冲取消回复。
- “停止朗读”保留麦克风。Gemini 使用本地静音当前轮剩余输出；这不代表取消上游推理或停止计费。
- 文字消息发送到当前实时会话；新文字会清理旧播报队列。
- 字幕来自服务商原生转写；Qwen/Higgs/Grok 按输入项目 ID 更新，Gemini 合并增量；历史会话的迟到回调不能写入新会话。
- 已注册的工具：查询本机时间；Qwen/Higgs/Grok 还可列举当前能力；千问可选 `ask_brain` 委派 Qwen 3.7 Plus。实时模型没有因此自动获得屏幕、文件或终端执行权限。
- 现有 Codex/原有 Agent 模式及其任务授权流程保留。实时模型模式隐藏不适用的传统 ASR/TTS 配置。

## 实现

- 正式后端：`backend/app/core/live_voice/`；没有对 `research/` 或旧 Demo 8767/8768 进程的运行依赖。
- 接口：`GET /v1/live-voice/catalog`、`PUT /v1/live-voice/config`、`WS /v1/live-voice/ws`。仅允许本机连接及可信本机 Origin/Host；配置写入须带 `X-Amadeus-Config: 1`。
- 传输：`frontend/desktop/src/services/liveVoiceWebSocket.ts`，播放取消隔离在 `realtimePlayback.ts`，独立音频 worklet 放在 `public/realtime-mic-worklet.js`。
- UI：`RealtimeVoiceConfig.tsx` 与 `RealtimeAgent.tsx`。模型和音色偏好持久保存；API Key 表单值只在组件内存中暂存。

## 本轮验证

- 后端 70 项离线测试：配置与来源校验、密钥遮蔽、禁用 Grok 时不连接上游、各模型协议、断开清理和打断回归。
- 前端 23 项页面测试、19 项音频传输/采集测试：配置保存、音色分组、模型切换、延迟字幕、旧音频过滤、异步停止竞态、44.1/48 kHz 重采样。
- TypeScript 检查、Vite 生产构建、Windows 目录打包通过。
- 主后端真实 API：Qwen、Gemini Live、Gemini 深度思考、Higgs 均返回语音、字幕及时间工具结果；Qwen/Gemini Live 另通过 PCM 语音输入与识别回传。
- 实际 Windows 打包应用已打开：3D 角色、模型目录和本机后端连接正常；Qwen 会话持续采集麦克风并收到后端采集确认，文字测试得到“爱弥斯实时语音已连接”的回复。验证后已结束会话，麦克风关闭。真人插话效果仍需实际体验。
- Gemini 深度思考一轮先播报“正在查询”，约 22 秒才完成工具结果播报；测试等待完整工具结果，没有把第一段结束当成整个任务结束。这里的时间是一次观察，不是平均延迟。
- 在线测试结果在本机 `.runtime/integrated_*_smoke.json`。可用 `scripts/smoke_live_voice_integration.py` 重跑；默认只检查目录，只有 `--run` 才使用模型额度。它不允许测试 Grok/OpenAI。
- 这些验证覆盖协议与集成，不能替代真实环境中长时间的麦克风、回声和对话质量体验。
