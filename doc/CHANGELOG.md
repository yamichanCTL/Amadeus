# CHANGELOG

> **父文档**: [← 返回文档索引](README.md)
> **子文档**:
> - [桌面端文档](desktop/README.md)

## [2026-07-04] 当日总结全流式、同目录归档与关闭选择恢复

- **类型**: feat / fix / refactor / test / docs
- **描述**: 当日总结和被动总结改用 NDJSON 全流式链路，前端收到 delta 后逐字符刷新，完成后才自动保存；结果区可列出并加载指定日期已生成的 Markdown。新音频与 JSON 使用同目录、同 stem 存放。实时对话单次 ASR 自动填入可编辑消息输入框。点击标题栏 X 恢复“保留后台 / 完全退出 / 取消”选择。根据 1600×1000 截图前置生成按钮并压缩 Prompt 卡片，修复配置区覆盖和首屏操作不可见。
- **影响范围**: `frontend/desktop/{electron,src,scripts}`、`backend/app/core/llm.py`、目标测试、`doc/{desktop,asrapp/backend,reports,assets/ui}`
- **验证**: Desktop Vitest 34 files / 103 tests、renderer/Electron TypeScript、Backend 全流式单测 1 passed、Python compileall、Vite、VitePress、两张 Electron 当前截图及 `git diff --check` 通过；真实 LLM 计费流与 Windows 进程退出仍按报告边界复验。
- **Plan**: [链接到 plan 文件](plans/2026-07-04-summary-stream-archive-close-dialog.md)
- **报告**: [总结全流式、同目录归档、ASR 回填与关闭选择验证报告](reports/2026-07-04-summary-stream-archive-close-dialog-report.md)

## [2026-07-04] 修复桌面归档、总结来源、结果回填与 Qwen3-ASR 持久化

- **类型**: feat / fix / refactor / test / docs
- **描述**: 实时识别现在收集实际发送的 PCM 并归档 WAV；本机识别归档按媒体类型、识别类别和日期分层。主动/被动总结显式选择本机记录或服务端归档，复用可命名、编辑和新增的 Prompt 卡片，且每次生成后自动写入唯一 Markdown 日志。离线与实时结果优先回填软件内结果区，弹窗复制从主进程同步路径移出；模型管理删除重复 LLM 后处理选项，字幕预览随设置实时更新。后端统一把 Qwen3-ASR 第三方结果转换为 JSON-safe 数据后再持久化。
- **影响范围**: `frontend/desktop/{electron,src}`、`backend/app/{core,db}`、目标测试与 `doc/{desktop,asrapp/backend}`
- **验证**: Desktop Vitest 29 files / 94 tests；renderer/Electron TypeScript、Vite 生产构建（82 modules）、Qwen JSON 定向 pytest 4 passed、Python compileall、VitePress 与 `git diff --check` 通过。当前环境的 Electron 截图执行因审批额度拒绝，未计为当前 UI 截图通过。
- **Plan**: [链接到 plan 文件](plans/2026-07-04-desktop-archive-summary-autofill-qwen-fixes.md)
- **报告**: [桌面归档、总结来源、结果回填与 Qwen3-ASR 验证报告](reports/2026-07-04-desktop-archive-summary-autofill-qwen-report.md)

## [2026-07-03] 桌面总结持久化、Prompt 卡片与分页设置

- **类型**: feat / fix / refactor / test / docs
- **描述**: 当日总结表单与结果提升为持久 store 状态并安全渲染 Markdown；模型管理页签更名为“LLM 设置”并移除重复 Prompt；语音识别页新增可选择、命名、编辑、保存、新增和删除的 Prompt 卡片；设置页按四类分页，默认开启桌面字幕；前端目录只用于本机保存且不再发送 `archive_dir`；隐私关闭时把最小化本机记录临时发送后端总结，主动/被动结果写入本机 `summary-logs`。
- **影响范围**: `frontend/desktop/{src,electron,scripts}`、`backend/app/{schemas/llm.py,core/llm.py}`、目标测试、`doc/desktop/`、`doc/asrapp/backend/API.md`
- **验证**: Desktop Vitest 22 files / 79 tests；renderer/Electron TypeScript、Vite build、Python compileall、后端本机 records 纯函数与四页 Electron 截图通过；后端 API pytest fixture 75 秒无输出后中止，未计为通过。
- **Plan**: [链接到 plan 文件](plans/2026-07-03-desktop-summary-prompt-cards-settings-pages.md)
- **报告**: [总结持久化、Prompt 卡片与分页设置验证报告](reports/2026-07-03-summary-prompt-cards-settings-pages-report.md)

## [2026-07-02] 提高初始窗口上限并保持居中

- **类型**: fix / test / docs
- **描述**: Electron 主窗口初始尺寸上限由 1180×760 调整为 1600×1000，继续按工作区约 78% 宽、82% 高自适应并居中；新增带偏移大工作区的尺寸上限和中心坐标回归测试。
- **影响范围**: `frontend/desktop/electron/window-layout.ts`、窗口边界测试、桌面窗口文档
- **验证**: Desktop Vitest 19 files / 73 tests；Renderer/Electron TypeScript、Vite 生产构建、VitePress 与 staged/unstaged diff check 通过。
- **Plan**: [链接到 plan 文件](plans/2026-07-02-initial-window-1600x1000.md)

## [2026-07-02] 修复 AI 润色归档、Both 总结与初始窗口尺寸

- **类型**: fix / feat / test / docs
- **描述**: 服务端同步/异步离线 ASR 归档新增脱敏 `llm_outputs` 与 `labels.ai_polished`；总结类型增加 `Both / 所有类型`，后端仅把开始时间、结束时间和一个优先 AI 润色的 label 发送给 LLM；初始窗口从接近全屏改为最大 1180×760 的紧凑居中布局。另从 SQLite 任务结果回填用户指定的 22:11:14 历史归档。
- **影响范围**: `backend/app/{core/archive.py,core/llm.py,api/v1/transcribe.py,tasks/asr_task.py}`、`frontend/desktop/{electron/window-layout.ts,src/pages/Summary.tsx,src/store/useASRStore.ts}`、定向测试与桌面文档
- **验证**: Desktop Vitest 19 files / 72 tests；Backend 定向 9 passed；Renderer/Electron TypeScript、Vite、Python compileall、VitePress 与 diff check 通过。指定归档提取实测只返回 `[22:11:14-22:11:14] 你看起来不会记路啊`。
- **Plan**: [链接到 plan 文件](plans/2026-07-02-archive-polish-both-summary-compact-window.md)
- **报告**: [润色归档、Both 总结与紧凑窗口验证报告](reports/2026-07-02-archive-polish-both-summary-compact-window-report.md)

## [2026-07-02] 桌面总结、隐私、模型发现、退出与输入可靠性

- **类型**: feat / fix / test / docs
- **描述**: ASR 同步/异步后处理日志新增 AI 润色最终文本；当日总结改为离线/实时固定选择，默认 `00:00` 至当前时间并新增持久化 Prompt；服务端 HTTP/Celery/WebSocket 调试归档全部改为严格 opt-in；模型管理按 `/v1/models` 能力动态发现新引擎；关闭窗口默认真正退出，只有显式启用后台运行才隐藏；Windows 文本 helper 首次异常时自动重建重试并预先保留剪贴板。
- **影响范围**: `backend/app/{api,core,schemas,tasks}`、`frontend/desktop/{electron,src}`、定向测试与 `doc/desktop/`
- **验证**: Desktop Vitest 19 files / 71 tests；Backend 定向 6 passed；Renderer/Electron TypeScript、Vite 生产构建和 Python compileall 通过。Windows 重启后真实输入与打包进程退出仍需 Windows 真机 E2E。
- **Plan**: [链接到 plan 文件](plans/2026-07-02-desktop-asr-summary-privacy-model-exit-input.md)
- **报告**: [总结、隐私、模型、退出与输入验证报告](reports/2026-07-02-desktop-summary-privacy-model-exit-input-report.md)

## [2026-06-30] 桌面 ASR 自动增强回填、响应式 UI 与复制卡顿修复

- **类型**: fix / refactor / test / docs
- **描述**: 删除语音识别页无功能人物区域；自动输入按设置优先投递润色/翻译结果；普通复制改为非阻塞单向 IPC；历史页使用内容容器断点并修复网格收缩；初始窗口占满工作区高度；标题栏最小化 glyph 居中；录音浮层增加取消/提交；润色和翻译前端配置合并；Windows 主窗口、托盘、可执行文件和安装包统一使用 `amadeus-icon.png`；根 README 按成熟开源项目结构重写。
- **影响范围**: `frontend/desktop/{electron,src,scripts,electron-builder.yml}`、`README.md`、`doc/desktop/`、`doc/reports/`
- **验证**: Desktop Vitest 15 files / 61 tests 全量通过；TypeScript renderer/Electron、Vite、Python compileall、VitePress 通过；Electron/Xvfb 五档截图无横向溢出，历史页无重叠；Windows 最终包与当前关键构建文件哈希一致且 rcedit 图标写入成功，真机 E2E 全局 `passed: true`：任务栏/EXE 头像正确、复制 0.1 ms、UIAutomation 连续第二次注入 128.1 ms、`×/✓` IPC 均为 `0→1`、DJI→CABLE 硬件通路及 1.152 秒纯麦克风采集通过；后端 auto-LLM 接口测试 1 passed in 0.64s。
- **Plan**: [链接到 plan 文件](plans/2026-06-30-desktop-asr-ui-polish.md)
- **报告**: [桌面 ASR 交互与自适应 UI 验证报告](reports/2026-06-30-desktop-asr-ui-e2e-report.md)

## [2026-06-30] 桌面 ASR 首连门禁、离线润色、布局与图标修复

- **类型**: feat / fix / test / docs
- **描述**: 桌面端新增后端地址“输入 + 确认”门禁，未确认时 health、模型刷新、离线 ASR、实时字幕、TTS/Agent 后端技能等路径均不主动连接后端；语音识别页新增离线 ASR 自动润色开关和用户 Prompt，复用模型管理 LLM 设置，后端继续排除 `api_token` 落库。语音识别页顶部放置“开始录音/实时识别”，移除“网络良好”和固定时间/延迟，文件识别移动到底部。字幕框 × 现在结束实时识别但不取消“显示桌面字幕框”设置。任务栏/托盘/打包图标改用由 `img/Amadeus/amadeus.jpg` 派生的 `.ico/.png`。
- **影响范围**: `frontend/desktop/src/{App.tsx,store,useASRStore.ts,services,pages,components,styles}`、`frontend/desktop/electron*`、`backend/app/{schemas,core,api,tasks}`、`img/Amadeus/`、桌面文档与专项测试
- **验证**: 前端 targeted Vitest 12 passed；renderer TypeScript、Electron TypeScript、Vite build、Python compileall 通过；后端轻量 schema 验证确认 Prompt 保留且 `api_token` 排除，`test_transcribe_auto_llm_success` 在本环境 90 秒无输出后中止，未计为通过。Electron/Xvfb 截图受沙箱限制未形成有效截图证据，已用 Image Gen 审查项指导 CSS 修复并记录限制。
- **Plan**: [链接到 plan 文件](plans/2026-06-30-desktop-asr-first-run-polish-ui-icon.md)

## [2026-06-29] 修复麦克风收音间断与非原始音

- **类型**: fix / test
- **描述**: 先新增端到端失败复现，确认离线/TTS 录音错误开启浏览器 AEC/降噪，且 AudioWorklet 缺失 block 会被 WAV 聚合器直接删除并压短时间轴。实体麦克风采集现统一关闭 AEC/NS/AGC；Worklet 增加音频帧位置，聚合器补齐 gap、去除 overlap 并在每轮录音重置时间轴。新增 30 秒/11,250 block 压测和 Windows 实体麦克风连续性探针。
- **影响范围**: `frontend/desktop/src/services/audio.ts`、音频连续性专项测试、`scripts/test_microphone_capture_continuity.sh`、`doc/desktop/`、测试报告
- **验证**: 修改前 DSP 约束和 8,192/12,288 样本缺失测试失败；修复后专项 15 passed，30 秒压力恢复完整 1,440,000 样本，前端全量 48 passed，TypeScript/Vite/Windows 目录打包通过；Windows 实体 DJI E2E 因执行额度限制待复跑
- **Plan**: [链接到 plan 文件](plans/2026-06-29-fix-microphone-capture-dropouts.md)

## [2026-06-29] 修复连续离线 ASR 第二次自动回填延迟

- **类型**: fix / test
- **描述**: 先新增连续双次离线识别端到端复现，确认后端即时返回但 Electron 主线程同步剪贴板写入与 STA helper 争用时会冻结事件循环，串行注入队列进一步积压第二轮。删除主线程重复剪贴板写入，增加 helper 启动预热/ready 握手，并改为 latest-wins 调度；pending 请求绑定具体 helper，旧进程事件不再误清理新请求。新增自动回填 telemetry、30 轮压力测试和 Windows 连续 textarea 注入验收。
- **影响范围**: `frontend/desktop/electron/{main,e2e,latest-task-queue}.ts`、`frontend/desktop/src/services/recordingService.ts`、专项测试与 `scripts/test_consecutive_offline_asr_fill.sh`、`doc/desktop/`、测试报告
- **验证**: 受控修改前第二轮 1190.2 ms、Windows 真机修复前约 9991.6 ms；修复后卡死场景约 13 ms，30 轮离线识别 p95 0.0 ms / max 0.1 ms，Windows textarea 第一轮 441.9 ms / 第二轮 130.2 ms且全套 E2E 通过；前端全量 44 passed，TypeScript 与 Vite build 通过
- **Plan**: [链接到 plan 文件](plans/2026-06-29-fix-consecutive-offline-asr-fill-latency.md)

## [2026-06-28] ASR 立即回填与 TTS 纯麦克风采集

- **类型**: fix / test
- **描述**: 语音转 TTS 改为 ASR 响应先回填、再请求 Higgs TTS，消除等待完整 TTS 音频造成的前端假卡死；模型管理参考文本移除固定首轮 1 秒轮询。离线 ASR、TTS 录音和实时 ASR 均改为独立采集所选实体麦克风，中转只负责输出，不再提供识别输入；回环/虚拟输出设备会被拒绝。新增 500 ms React 端到端门槛、30 轮压力测试和真实后端 warm-path 压测脚本。
- **影响范围**: `frontend/desktop/src/pages/{VoiceChanger,Models,Transcribe}.tsx`、`frontend/desktop/src/services/{audio,recordingService}.ts`、专项测试与 `scripts/`、`doc/desktop/`
- **验证**: 专项 5 passed；前端全量 39 passed；真实 SenseVoice warm HTTP 222.5 ms 且文本准确；TypeScript、Vite、后端定向测试通过
- **Plan**: [链接到 plan 文件](plans/2026-06-28-fix-asr-immediate-fill-pure-mic-capture.md)

## [2026-06-26] 全项目分层测试与压力测试 — 发现 5 个 BUG

- **类型**: test
- **描述**: 完成三层测试验证 + 创建可复用测试脚本。(1) **259 单元/集成测试** 0 fail；(2) **47 端到端功能测试** 100% 通过；(3) **6 场景压力测试**：多用户并发 ASR (5/10/15/20u)、混合负载、30s 长会话稳定性 (2257 req, 75req/s)。**发现 5 个 BUG**: 🚨Records 端点 5 并发下 82x 退化 (0.15s→12.76s)、🚨ASR 模型串行化 (20u p95=8.6s, 6x退化)、❌无效引擎静默 fallback 应返回 422、❌不存在 skill 返回 404 应返回 200+fail、⚠️Higgs voices 跨服务 403ms。前端 TypeScript + Vite build 通过。创建 `scripts/stress_test.py` 和 `scripts/e2e_live_test.py` 可复用脚本。
- **影响范围**: `tests/` (6 新文件 71 tests)、`backend/tests/conftest.py` (修复)、`scripts/stress_test.py` (新增)、`scripts/e2e_live_test.py` (新增)、`TEST_REPORT.md`、`doc/CHANGELOG.md`
- **验证**: pytest 259 pass 0 fail；E2E 47/47；压力测试 6 场景完成；前端 tsc+vite build 通过
- **Plan**: N/A（探索性任务）

## [2026-06-25] 二次修复离线 ASR 立即输入与纯麦克风录音

- **类型**: fix
- **描述**: 离线 ASR 在拿到最终文本后立即启动自动输入/复制，不再等待前端状态更新、历史记录、归档或 telemetry；Windows 录音开始前捕获原前台窗口，注入时先恢复该窗口再粘贴，降低 QQ 等聊天框被状态浮窗/焦点变化影响的概率。离线快捷录音和 `语音转 TTS` 录音只采集麦克风输入；后续回归修复进一步将 relay 激活时的路径改为克隆 relay 内部输入轨道，避免二次打开麦克风。
- **影响范围**: `frontend/desktop/electron/main.ts`、`frontend/desktop/electron/preload.ts`、`frontend/desktop/src/vite-env.d.ts`、`frontend/desktop/src/services/recordingService.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`doc/desktop/SPEECH_RECOGNITION.md`、`doc/desktop/INPUT_AND_OVERLAYS.md`、`doc/desktop/TTS_VOICE.md`
- **验证**: `node node_modules/typescript/bin/tsc --noEmit`；`node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit`；`node node_modules/vite/bin/vite.js build`；`git diff --check`
- **Plan**: [链接到 plan 文件](plans/2026-06-25-lock-foreground-pure-mic-immediate-inject.md)

## [2026-06-25] 回归修复 relay 录音与 QQ 兼容注入

- **类型**: fix
- **描述**: 修复上一轮把离线/TTS 录音强制改为再次打开麦克风带来的设备占用和卡顿风险：relay 激活时改为克隆 relay 内部输入麦克风轨道，仍不连接输出混音总线。录音前目标窗口捕获改为非阻塞，不再挡住录音浮窗与麦克风启动。Windows 注入 helper 额外传递捕获到的目标进程名，QQ/TIM/微信目标恢复后直接走兼容粘贴路径，减少 UIA 焦点识别失败导致的“不输入”。
- **影响范围**: `frontend/desktop/electron/main.ts`、`frontend/desktop/src/services/recordingService.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`doc/desktop/SPEECH_RECOGNITION.md`、`doc/desktop/INPUT_AND_OVERLAYS.md`、`doc/desktop/TTS_VOICE.md`
- **验证**: `node node_modules/typescript/bin/tsc --noEmit`；`node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit`；`node node_modules/vite/bin/vite.js build`；`git diff --check`
- **Plan**: [链接到 plan 文件](plans/2026-06-25-regression-fix-input-relay-qq.md)

## [2026-06-25] 复查并修复 QQ 输入失败与录音卡住

- **类型**: fix
- **描述**: 修复离线 ASR 和 TTS 录音状态机：开始时立即进入 `recording`，麦克风启动/停止增加超时兜底，停止后立刻切 `thinking`，成功/失败都会关闭或切换状态浮窗。录音器优先使用 Web Audio PCM 并封装 WAV，`MediaRecorder` 仅作兜底，降低 WebM/Opus 分片卡顿导致的 ASR 误识别。Windows 自动输入 helper 增加 QQ/TIM/微信兼容分支，聊天输入区暴露为非标准控件时仍尝试粘贴。
- **影响范围**: `frontend/desktop/electron/main.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/services/recordingService.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`doc/desktop/SPEECH_RECOGNITION.md`、`doc/desktop/INPUT_AND_OVERLAYS.md`、`doc/desktop/TTS_VOICE.md`
- **验证**: `node node_modules/typescript/bin/tsc --noEmit`；`node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit`；`node node_modules/vite/bin/vite.js build`；`git diff --check`
- **Plan**: [链接到 plan 文件](plans/2026-06-25-reinvestigate-input-recording-stuck.md)

## [2026-06-25] 修复 ASR 低延迟输入与 TTS 收音卡顿

- **类型**: fix
- **描述**: ASR 结果投递改为先输入后后台归档，避免 `blobToBase64` 和文件写入挡在自动粘贴前；Windows 文本注入改为常驻 PowerShell STA helper，UIAutomation 与 SendInput 只初始化一次，减少每次结果返回后的冷启动延迟，并在失败时保留剪贴板和结果浮窗。实时 ASR/TTS 的 PCM 采集优先使用 `AudioWorklet`，WebSocket 发送增加 64KB 背压保护；变声器录音在空闲时预热麦克风，开始录音不再同步等待预热。
- **影响范围**: `frontend/desktop/electron/main.ts`、`frontend/desktop/src/services/recordingService.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`doc/desktop/TTS_VOICE.md`
- **验证**: `node node_modules/typescript/bin/tsc --noEmit`；`node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit`；`node node_modules/vite/bin/vite.js build`；`git diff --check`
- **Plan**: [链接到 plan 文件](plans/2026-06-25-fix-low-latency-inject-and-tts-input.md)

## [2026-06-24] 修复变声器播放按钮 + 录音卡顿 + 状态浮窗

- **类型**: fix
- **描述**: 三项修复：
  1. **「播放到输出设备」按钮**：按钮使用独立 `playAudioBlobToDevice`（`AudioContext.setSinkId`），只在中转关闭时创建独立 AudioContext，不影响 relay 透传；`playAudioBlob` 保持原 HTML5 Audio 实现。
  2. **录音卡顿**：根因是中转激活时 `prepare()` 打开了第二路麦克风（16kHz+AEC），与 relay 的麦克风流冲突导致 WSL2 音频异常。修复为仅在 relay 关闭时 `prepare()`，对齐 `recordingService` 的行为。同时 `MediaRecorder` 添加 `onerror` 处理器，timeslice 100→250ms 减少 Opus 碎片化。
  3. **状态浮窗**：TTS 处理时调用 `showStatusOverlay('thinking')` 覆盖之前的「语音输入中」残留，完成/失败后 `hideStatusOverlay()`。
- **影响范围**: `frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`
- **验证**: TypeScript 编译零错误。

## [2026-06-24] 修复自动注入/后端地址通信/浮窗拖动波形/录音页面切换卡死

## [2026-06-24] 修复自动注入/后端地址通信/浮窗拖动波形/录音页面切换卡死

- **类型**: fix / refactor
- **描述**: 5 项桌面端 bug 修复。①自动注入放宽焦点检测：`IsKeyboardFocusable` 不再作为硬性早退条件，Electron/QQ/VSCode 等富文本编辑器不再被误判为"不可编辑"；新增 stderr 诊断日志。②后端地址通信：移除 `normalizeServerUrl` 和 `buildWsUrl` 中 Electron 环境自动回退 `localhost:8000` 的逻辑；Settings 后端地址改为「草稿+确认」交互，未确认不进行任何通信；WebSocket 客户端空地址时拒绝连接并提示配置。③浮窗拖动+波形：status overlay 改为 `movable: true`，录音/thinking 阶段用 `setIgnoreMouseEvents(true, {forward:true})`+拖动手柄实现可拖动；拖动位置跨 phase 保留；`startLevelMonitor` 从 `requestAnimationFrame` 改为 `setInterval` 避免后台窗口节流导致波形冻结。④录音与页面解耦：新增 `recordingService` 单例（参照 `liveCaptionService` 模式），Transcribe 页面卸载不再中断进行中的录音/识别；`stop()` 异常时 catch 兜底 `hideStatusOverlay` 不卡 thinking；全局热键直接调用 `recordingService.toggle()` 跨页面可用。
- **影响范围**: `electron/main.ts`、`electron/status-overlay-preload.ts`、`src/services/api.ts`、`src/services/audio.ts`、`src/services/liveCaption.ts`、`src/services/recordingService.ts`（新增）、`src/pages/Transcribe.tsx`、`src/pages/Settings.tsx`、`src/App.tsx`、`src/vite-env.d.ts`
- **验证**: TypeScript renderer+node 零错误；后端 pytest 185 passed。
- **Plan**: [链接](plans/2026-06-24-fix-inject-backend-overlay-recording.md)

## [2026-06-24] 修复跨应用注入、可迁移路径与 X-ASR CUDA 冲突

- **类型**: fix / refactor / deployment
- **描述**: 普通收音/Thinking/Error 浮窗缩小为 200×32，28 段波形改为连续电平时间历史；自动输入保留 UI Automation 严格判断，并为 QQ/TIM/微信、VS Code/Cursor/Trae 的自绘编辑器加入受限进程兼容分支。后端模型、数据、外部源码和动态库路径集中到 `.env`，应用代码不再包含部署机绝对路径。CUDA X-ASR 使用独立 spawn worker 隔离 sherpa CUDA 12/cuDNN 9 与主进程 PyTorch CUDA 13/cuDNN 9.20，修复 `CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH`。桌面与后端默认 ASR 超时保持 20 秒。
- **影响范围**: `frontend/desktop/electron/`、`backend/app/config.py`、`backend/app/core/asr/engines/x_asr.py`、`backend/.env.example`、后端路径使用点与部署文档
- **验证**: X-ASR 960 ms CUDA 真机解码通过（213 块、6 partial、1 final）；Python 单元测试、前端 TypeScript/Vite 和文档构建见 Plan 执行记录。QQ/VS Code 的 SendInput 仍需 Windows 本机 E2E 验证。
- **Plan**: [优化状态浮窗与自动输入](plans/2026-06-23-refine-status-overlay-and-auto-inject.md)

## [2026-06-23] 修复扬声器输入、离线结果投递与 20 秒超时

- **类型**: fix / feat
- **描述**:
  1. Windows 正式构建放行主窗口的系统音频采集权限，扬声器 loopback 统一接入快捷录音、实时字幕、Agent 语音与设置页输入测试；来源选择保持同步，失败不再错误回退到麦克风占位设备。
  2. 离线 ASR 完成后使用 UI Automation 检查当前焦点是否可编辑；可编辑时在光标处粘贴，不可编辑时复用 Thinking 浮窗展示结果，并提供“复制”和“×”按钮。
  3. 录音浮窗删除低电平设备告警，只显示“语音输入中”，并扩大 RMS/peak 波形。
  4. 桌面端和后端默认转写超时统一为 20 秒；请求显式携带 `timeout_sec`，同步/异步 ASR 推理均执行限制，`0` 仍表示不限制。
- **影响范围**: `frontend/desktop/electron/`、`frontend/desktop/src/{services,pages,store}`、`backend/app/{config.py,schemas/transcribe.py,api/v1/transcribe.py,tasks/asr_task.py}`、桌面与 Backend API 文档
- **验证**: Renderer/Electron TypeScript、Vite 生产构建、Python 模块编译和后端默认值断言通过；Windows loopback 与真实跨应用注入需在 Windows E2E 中完成硬件验证。
- **Plan**: [修复扬声器输入与离线识别结果投递](plans/2026-06-23-fix-speaker-input-and-offline-result-delivery.md)

## [2026-06-23] 实时识别多项改进：独立时间戳、字幕框优化、托盘开关、页面切换不中断

- **类型**: feat / fix
- **描述**:
  1. **每句话独立时间戳**（需求1）：实时识别保存历史时，每句话独立成块（`HH:MM:SS → HH:MM:SS\n文本`），`segments` 保留毫秒级 start/end。不再把所有句子 join 成一段。
  2. **字幕框优化**（需求2）：
     - 点击"实时识别"立即弹出字幕框显示"正在聆听…"（不再等到首条文本到达）
     - 点击字幕框 × 关闭按钮同时停止实时识别
     - 字幕框只显示最近 2 行，超出自动刷掉（原 4 行）
     - 动态调整大小保持支持
  3. **离线识别超时设置**（需求3）：已实装（Settings 页`超时秒数`输入框，0=不限制）
  4. **托盘图标实时识别开关**（需求4a/4c）：Windows 托盘右键菜单增加"开启实时识别"/"停止实时识别"项，点击切换状态，菜单标签同步更新
  5. **切换 UI 界面不终止实时识别**（需求4b）：将 `StreamingASRClient` 生命周期从 `TranscribePage` 组件本地 ref 提升为 `LiveCaptionService` 模块级单例，页面切换不再触发 streamer.stop()。两处开关（UI 按钮 + 托盘菜单）统一调用同一单例。
- **影响范围**:
  - `frontend/desktop/src/services/liveCaption.ts`：**新文件** - `LiveCaptionService` 模块级单例，管理流式识别完整生命周期
  - `frontend/desktop/src/store/useASRStore.ts`：新增 `UtteranceEntry` 类型导出、`liveUtterances` + `setLiveUtterances` 状态
  - `frontend/desktop/src/pages/Transcribe.tsx`：移除本地 streamer/utterances 逻辑（~80行），改用 `liveCaptionService` + store
  - `frontend/desktop/src/App.tsx`：字幕框关闭时停止识别；监听托盘 toggle IPC
  - `frontend/desktop/electron/main.ts`：`buildTrayMenu()` 动态托盘菜单；`liveCaption:stateChanged` IPC
  - `frontend/desktop/electron/preload.ts`：新增 `onLiveCaptionTrayToggle`、`notifyLiveCaptionState`
  - `frontend/desktop/src/vite-env.d.ts`：新增类型声明
- **验证**: Renderer TypeScript 零错误；Vite 生产构建通过（77 模块）。
- **Plan**: [实时识别多项改进](plans/2026-06-23-fix-previous-round-regressions.md)

## [2026-06-23] 修复实时识别 WebSocket、多模型并发加载、X-ASR 默认 960ms chunk

- **类型**: fix / feat
- **描述**:
  1. **修复实时识别 WebSocket 连接超时**：`audio.ts` 的 `buildWsUrl()` 在 Electron `file://`/`app://` 协议下 `window.location.host` 为空，导致生成 `ws:///v1/stream`（三斜杠的无效 URL）。新增与 `api.ts` 的 `normalizeServerUrl()` 一致的 fallback 逻辑，Electron 环境下自动 fallback 到 `ws://localhost:8000`。
  2. **支持同时加载多个模型**：Models 页面的 `busy: string` 单值状态阻止了并发加载。改为 `busyEngines: Set<string>`，每个引擎独立追踪加载状态，不同引擎可同时加载。加载失败（如显存不足）时后端返回分类错误信息，前端仅展示该引擎的错误，不影响其他引擎的加载。
  3. **X-ASR 默认使用 960ms chunk 模型**：前端 `DEFAULT_SETTINGS` 和 `defaultAsrConfigs`、后端 `config.py` 的 `default_x_asr_model` 和 `x_asr_model_dir` 均改为 `chunk-960ms-model`。识别时模型未加载会自动加载（后端 `/v1/stream` 已内置 lazy load）。
  4. **清理过时 docstring**：`model_manager.py` 删除已移除的全局信号量描述。
- **影响范围**:
  - `frontend/desktop/src/services/audio.ts`：`buildWsUrl()` Electron fallback
  - `frontend/desktop/src/pages/Models.tsx`：`busyEngines: Set<string>` 并发加载
  - `frontend/desktop/src/store/useASRStore.ts`：默认 chunk-960ms-model
  - `backend/app/config.py`：默认 chunk-960ms-model
  - `backend/app/core/model_manager.py`：更新 docstring
- **验证**: Renderer TypeScript 通过（`npx tsc --noEmit` 零错误）。
- **Plan**: [修复上一轮引入的问题 + 新增需求](plans/2026-06-23-fix-previous-round-regressions.md)

## [2026-06-23] 修复上一轮引入的回归问题

- **类型**: fix
- **描述**:
  1. **移除全局加载信号量**：上轮加入的 `_global_load_semaphore(1)` 强制串行化所有模型加载，反而阻止了并发加载。已移除；保留 `_clear_gpu_cache()` 与 GPU 内存日志用于 OOM 诊断；CUDA OOM 仍由 `classify_model_error` 捕获并返回中文提示。
  2. **修复托盘/窗口/.exe 图标不显示**：新增 `resolveAssetPath()` 辅助函数，dev 模式从仓库根 `img/Amadeus/` 读取，生产环境从 `process.resourcesPath` 读取。`electron-builder.yml` 新增 `icon` 字段与 `extraResources` 配置将 `amadeus.jpg` 打包到安装目录。
  3. **修复通路监听 toggle 卡死**：`startMonitor(0)` 的 Promise 永不自行 resolve，`await` 它会导致事件循环卡在 Promise 上。改为 fire-and-forget 模式 + `useRef`(monitorActiveRef) 作为防竞态门，避免 React state 闭包陈旧导致的重复启动/无法停止。
  4. **确认虚拟麦克风纯透传未被破坏**：`audio.ts` 中 `echoCancellation: false, noiseSuppression: false, autoGainControl: false` 完整保留，micAnalyser 电平探针与 injectionGain TTS 叠加路径均正确。
- **影响范围**:
  - `backend/app/core/model_manager.py`：移除全局信号量
  - `frontend/desktop/electron/main.ts`：`resolveAssetPath()`、`loadAppIcon()`、修正 createTray/createWindow
  - `frontend/desktop/electron-builder.yml`：`icon` + `extraResources`
  - `frontend/desktop/src/pages/Settings.tsx`：`toggleMonitor` fire-and-forget + `monitorActiveRef`
  - `frontend/desktop/src/services/audio.ts`：新增 `isMonitoring()`
- **验证**: Renderer/Electron TypeScript 通过；Vite 生产构建通过（76 模块）；Python compileall 通过。
- **Plan**: [修复上一轮引入的问题](plans/2026-06-23-fix-previous-round-regressions.md)

## [2026-06-22] 多模型加载保护、开机自启、品牌图标与通路测试优化

- **类型**: feat / fix / refactor
- **描述**:
  1. **模型并发加载保护**：`ModelManager._load_engine()` 增加全局 `asyncio.Semaphore(1)` 序列化所有模型加载，避免并发 GPU 分配导致 CUDA OOM 或驱动卡死；加载前调用 `torch.cuda.empty_cache()` 清理碎片，加载失败时同样清理；新增 `get_gpu_memory_info()` 供诊断查询；`hot_swap` 先卸载旧模型再加载新模型并清理缓存。
  2. **开机自动启动**：设置页新增"开机自动启动 Amadeus"checkbox，通过 Electron `app.setLoginItemSettings` 实现；启动时从 OS 读取当前状态同步到 store。
  3. **托盘图标**：托盘图标改为从 `img/Amadeus/amadeus.jpg` 加载并 resize 到 16×16，失败时用空图标降级。
  4. **应用图标**：`BrowserWindow` 构造时设置 icon 为 `img/Amadeus/amadeus.jpg`。
  5. **删除过时文案**：移除 TitleBar 的"智能语音工作台"和 Sidebar 的"智能语音助手"。
  6. **Sidebar 品牌图标**：品牌区音频波形条形图替换为 amadeus.jpg 图片（`brand-logo` class）。
  7. **通路测试交互改造**：设置页通路测试改为 toggle 模式（点击开始监听 → 再次点击停止），不再限时 5 秒，删除独立停止按钮。`AudioRelayMixer.startMonitor(durationMs)` 支持 `durationMs=0` 不自动停止。
- **影响范围**:
  - `backend/app/core/model_manager.py`：全局信号量 + GPU 内存清理
  - `frontend/desktop/electron/main.ts`：托盘图标、窗口图标、auto-launch IPC
  - `frontend/desktop/electron/preload.ts`：auto-launch API
  - `frontend/desktop/src/components/Sidebar.tsx`：品牌图标 + 文案
  - `frontend/desktop/src/components/TitleBar.tsx`：文案
  - `frontend/desktop/src/pages/Settings.tsx`：通路测试交互 + 开机自启
  - `frontend/desktop/src/store/useASRStore.ts`：`autoLaunchEnabled` 字段
  - `frontend/desktop/src/vite-env.d.ts`：auto-launch 类型声明
  - `frontend/desktop/src/App.tsx`：auto-launch 启动同步
  - `frontend/desktop/src/services/audio.ts`：`startMonitor(0)` 无限监听
  - `frontend/desktop/src/styles/global.css`：`.brand-logo` 样式
- **验证**: renderer/Electron TypeScript 通过；Vite 生产构建通过（76 模块）；Python compileall 通过。
- **Plan**: [多模型加载、开机启动、托盘图标与 UI 优化](plans/2026-06-22-multi-model-loading-autostart-tray-icons.md)

## [2026-06-22] 修复虚拟麦克风错误叠加导致 ASR 异常

- **类型**: fix / feature
- **描述**: 关闭 `AudioRelayMixer` 的浏览器 AEC/NS/AGC DSP 实现纯透传（波形一致），确保 `createInputStream()` clone 的 ASR 轨道不受 DSP 扭曲；新增回环保护拒绝将虚拟线缆输出端用作输入；新增设置页通路调试面板（输入/监听电平条 + 5 秒默认扬声器监听）验证“真实麦克风 → 虚拟麦克风 → 默认扬声器”通路。
- **修改文件**:
  - `frontend/desktop/src/services/audio.ts`: `AudioRelayMixer.start()` 约束改为 `echoCancellation: false, noiseSuppression: false, autoGainControl: false`；新增 `isLoopbackPair()` 导出函数与 `normalizeCableLabel`、`resolveOutputLabel` 辅助函数；新增 `micAnalyser` 节点与 `getInputLevel()` 方法；新增独立 `monitorContext` 与 `startMonitor()`/`stopMonitor()`/`getMonitorLevel()` 方法；`stop()` 清理新增节点。
  - `frontend/desktop/src/pages/Settings.tsx`: 新增通路调试面板（输入/监听电平条 + 开始监听/停止按钮），仅在 `audioRelayEnabled` 时渲染；新增 RAF/定时器电平刷新循环。
- **验证**: renderer/Electron TypeScript 通过；Vite 生产构建通过（75 模块）；Python compileall 通过。

## [2026-06-22] 恢复异常回退的 Amadeus 桌面实现

- **类型**: fix / docs
- **描述**: 对照 2026-06-21 的实际补丁记录，恢复被回退的 Electron 主进程、语音识别页、设置页、响应式样式、持久状态版本和安装包产品名。恢复内容包括麦克风预热与真实电平、统一强制停止、Windows user32 跨应用粘贴、中下部动态状态浮窗、字幕控制、用户 ID、持久音频中转、560×460 最小窗口和隔离 Windows E2E 接入。
- **影响范围**: `frontend/desktop/electron/main.ts`、`frontend/desktop/electron-builder.yml`、`frontend/desktop/src/pages/Transcribe.tsx`、`frontend/desktop/src/pages/Settings.tsx`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`
- **验证**: renderer/Electron TypeScript、Vite 生产构建、Python compileall、后端定向 pytest（`6 passed`）、VitePress 文档构建和 `git diff --check` 均通过。
- **Plan**: [恢复异常回退的 Amadeus 桌面文件](plans/2026-06-22-restore-amadeus-reverted-files.md)

## [2026-06-21] Amadeus 桌面录音、浮窗、跨应用输入与音频路由

- **类型**: feat / fix / refactor / docs
- **描述**: 桌面产品更名为 Amadeus；全局预热麦克风并以 100 ms timeslice 保护开头采音，状态浮窗移到屏幕中下部并增加真实电平波形和动态 thinking。录音、上传/轮询、后端任务与实时流增加统一强制停止；Windows 自动输入改为剪贴板优先加 user32 Ctrl+V。实时预览压缩为秒级时间范围加文本，字幕框增加关闭/设置按钮和动态尺寸配置。移除固定 body 最小宽度并加入 980/760/560 响应式断点。音频中转提升为持久应用级单例，DJI 等真实输入常态透传，TTS/音效叠加到 CABLE 等虚拟输出。设置新增用户 ID 并写入 Electron `archive/userid`，同时传给文件和实时归档。
- **验收工具**: 新增隔离的 Windows `--amadeus-e2e` 模式和 `scripts/run_amadeus_windows_e2e.ps1`，可实际验证 user32 粘贴、动态浮窗按钮、580×500 响应式布局，以及 DJI→CABLE Input/Output 的 WebAudio 回环，不触碰用户当前编辑器输入框。
- **影响范围**: `frontend/desktop/`、`backend/app/api/v1/transcribe.py`、`backend/app/schemas/transcribe.py`、`backend/app/tasks/asr_task.py`、`backend/tests/test_amadeus_desktop.py`、`doc/desktop/`
- **测试报告**: [Amadeus 桌面输入、浮窗与音频路由测试报告](reports/2026-06-21-amadeus-desktop-capture-overlay-routing-test-report.md)
- **Plan**: [Amadeus 录音、浮窗、输入注入与音频路由改造](plans/2026-06-21-amadeus-capture-overlay-routing-userid.md)

## [2026-06-21] 修复实时停止、补齐状态反馈与历史日期筛选

- **类型**: fix / feat / docs
- **描述**: 实时 ASR 停止改为立即、幂等地停止采集和关闭连接，补齐连接接受、模型加载、就绪和配置完成反馈；实时变声和免按键 Agent 同步消费连接状态。历史记录增加文本、语言及包含边界日的起止日期筛选，时间精确到秒，并区分清空筛选与删除记录。新安装默认使用右 Alt 触发语音识别，旧默认鼠标中键自动迁移；Windows 提供全局右 Alt hook。新增后端、桌面、Android、第三方模型和环境迁移分层指南。
- **影响范围**: `frontend/desktop/`、`doc/asrapp/installation/`、`doc/desktop/SPEECH_RECOGNITION.md`
- **Plan**: [实时识别停止、状态反馈、历史筛选与环境迁移](plans/2026-06-21-realtime-stop-status-history-install-right-alt.md)

## [2026-06-21] 降低实时 TTS 延迟并隔离输出回声

- **类型**: fix / perf / docs
- **描述**: 保留 stable-only 和词边界约束，将无标点中文的提前提交改为 8 个稳定字、1 字 look-ahead，并用 jieba 避免切断词语；真实 Elysia 长音频首次 TTS 从 final 改为 partial，语音 onset 到首 PCM 从 4.905 s 降至 3.864 s，拼接文本仍与全部 ASR final 一致且无微片段。中转麦克风启用 AEC/降噪，实时链路拒绝 monitor/stereo-mix/loopback 输入，AEC 不可用时播放期自动 half-duplex；后端新增跨 job 的 8 秒 TTS 文本回声保护和 `echo_suppressed` 事件。桌面端增加输入电平测试、指定输出测试音和播放队列保护窗口，并完成 WSLg `RDPSource` / `RDPSink` 实测。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/Settings.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`scripts/benchmark_realtime_asr_tts.py`、`scripts/test_audio_devices.sh`、`doc/`
- **测试报告**: [实时 TTS 延迟、回声隔离与设备测试报告](reports/2026-06-21-realtime-tts-latency-echo-device-test-report.md)
- **Plan**: [实时 TTS 延迟、回声隔离与设备验证计划](plans/2026-06-21-realtime-tts-latency-echo-device-validation.md)

## [2026-06-21] 修复流式模型失败后 WebSocket 卡死

- **类型**: fix / docs
- **描述**: X-ASR CUDA recognizer 创建后先执行真实静音 decode warm-up，成功后才标记模型已加载；运行期 native decode 失败会撤销 loaded 状态。后端将 CUDA/cuDNN 运行时异常稳定返回为 `model_not_loaded`（“模型没有加载”），将 CUDA/ONNX 内存分配失败返回为 `gpu_out_of_memory`（“显存不足”）。`/v1/stream` 与 `/v1/tts/higgs/stream` 发送带 `fatal=true` 的错误后立即关闭 WebSocket，并通过 abort 路径丢弃失败 decoder，避免再次 `finish()` 导致连接卡死。
- **影响范围**: `backend/app/core/model_errors.py`、`backend/app/core/model_manager.py`、`backend/app/core/asr/engines/x_asr.py`、`backend/app/core/streaming/session.py`、`backend/app/api/v1/stream.py`、`backend/app/api/v1/tts_api.py`、`backend/tests/`、`doc/asrapp/backend/`
- **Plan**: [修复流式模型失败后 WebSocket 卡死](plans/2026-06-21-fix-streaming-model-failure-hang.md)

## [2026-06-21] 修复实时 TTS 单字碎片、语义改变和分段停顿

- **类型**: fix / perf / docs
- **描述**: 撤销“首个 unstable partial 立即合成”的激进策略；partial 现在只使用连续 hypothesis 的稳定文本，首段至少 6 个字符、后续至少 8 个字符，并且只在自然标点或安全空格边界提交，短句统一等待 final 整句合成。final 修正已播前缀时不再按字符位置切片，避免产生错误后缀。Higgs PCM 增加 20 ms 在线边界静音门控，保留自然短停顿并压缩长首尾静音；有效语音后连续静音达到 900 ms 会提前关闭上游请求，避免阻塞下一段。真实短句只提交 `你好，世界` 一个 TTS 片段，文本与 ASR final 完全一致，播放缓冲 underrun 为 0 ms，裁掉 1040 ms 边界静音。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`scripts/benchmark_realtime_asr_tts.py`、`doc/desktop/TTS_VOICE.md`
- **测试报告**: [实时 TTS 语义与连续性测试报告](reports/2026-06-21-realtime-tts-semantic-quality-test-report.md)
- **Plan**: [修复实时 TTS 语义碎片计划](plans/2026-06-21-fix-realtime-tts-semantic-fragmentation.md)

## [2026-06-21] 实时 X-ASR 增量文本到 Higgs 流式 TTS 延迟优化

- **类型**: feat / fix / perf / docs
- **描述**: 将累计 X-ASR partial 改为有序、去重的增量文本 TTS 队列，final 只补发剩余文本；配置阶段预热 VAD、X-ASR 与 Higgs 音色后再打开麦克风；VAD/X-ASR 推理移出 WebSocket 事件循环；Higgs 原始 PCM 首包直接转发，恢复 `initial_codec_chunk_frames=1`，前端跨增量 job 连续播放。真实 2.32 秒中文录音在 X-ASR 160 ms CUDA + Elysia 上测得语音 onset 到首 PCM 1.487 秒，ASR 首 partial 到首 PCM 0.363 秒。
- **影响范围**: `backend/app/main.py`、`backend/app/api/v1/tts_api.py`、`backend/app/core/asr/engines/x_asr.py`、`backend/app/core/streaming/`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`scripts/benchmark_realtime_asr_tts.py`、`backend/tests/`、`doc/desktop/TTS_VOICE.md`
- **测试报告**: [2026-06-21 实时 ASR→TTS 延迟测试报告](reports/2026-06-21-realtime-asr-tts-1s-test-report.md)
- **Plan**: [实时 ASR→流式文本→Higgs 流式 TTS 计划](plans/2026-06-21-realtime-asr-streaming-text-higgs-1s.md)

## [2026-06-21] 修复语音转 TTS 报错 "Part exceeded maximum size of 1024KB"

- **类型**: fix
- **描述**: 
  - **根因1 (WebSocket 流式)**: `_send_stream_tts_events()` 在 `tts_chunk` 逐 chunk 送达音频后，将全部合成音频 base64 编码为单条 WebSocket 消息发送，长语音会超出 `websockets` 库默认 1MB 限制。**修复**: 移除冗余的完整合并 `tts` 事件。
  - **根因2 (HTTP multipart 上传 — 用户实际报错)**: Starlette 在 `Request._get_form()` 和 `MultiPartParser.__init__` 两处均硬编码 `max_part_size=1024*1024`（1MB）。`_get_form()` 将该值作为 keyword 传入 `MultiPartParser`，仅修改类变量无法覆盖。**修复**: monkey-patch `MultiPartParser.__init__`，无条件将 `max_part_size` 替换为 `settings.max_upload_size_bytes`（500MB）。
- **影响范围**: `backend/app/main.py`、`backend/app/api/v1/tts_api.py`
- **Plan**: [plans/2026-06-21-fix-websocket-1024kb-limit.md](plans/2026-06-21-fix-websocket-1024kb-limit.md)

## [2026-06-21] 变声器音色直接切换、默认音色改为 Elysia、移除 TTS 延迟面板、优化开发调试台

- **类型**: fix / refactor
- **描述**: 
  - 修复桌面变声器/TTS 页面中音色下拉只更新音色名但不加载预设参考信息的问题。切换音色时自动查找已保存预设并应用全部引用字段。
  - TTS 默认音色从 `'default'` 改为 `'Elysia'`（覆盖 store 初始值、merge 回退、组件回退、API 层回退、WebSocket 层回退）。
  - 移除变声器/TTS 页面的延迟面板（`.voice-latency-panel`），相关实时 TTS 延迟信息迁移到开发调试台的 telemetry 追踪中。
  - 修复模型管理 ASR 页打开时 SenseVoice 自动展开的问题（`expandedAsrEngine` 初始值改为空字符串）。
  - **开发调试台重构**：事件按任务链路（trace）分组，每条链路默认可折叠，点击展开查看阶段瀑布图和详情；无 traceId 的事件（如定时健康检查）收入可折叠的「其他事件」区；新增事件/任务链路/平均/P95/错误五栏概览。
- **影响范围**: `frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-21-voice-changer-preset-switching.md)


## [2026-06-20] 修复 WebSocket 连接超时并延迟 VAD 加载

- **类型**: fix
- **描述**: 
  - 后端 `/v1/stream` 在 `websocket.accept()` 后立即发送 `{"type":"accepted"}` 消息，避免 FireRed VAD 加载期间客户端无响应
  - 后端增加 `{"type":"loading"}` 心跳消息，在模型加载超过 3s 时周期发送，防止客户端误判连接死掉
  - `StreamingASRSession` 将 VAD 模型创建延迟到首次 `accept_audio()`（对齐 X-ASR 参考实现的延迟加载模式），WebSocket 连接现在瞬间完成不受模型加载影响
  - 前端 WebSocket 连接超时从 5s 增加到 15s
  - 前端增加 `accepted`/`loading` 消息类型处理
  - 前端错误诊断信息增加具体建议：Nginx 反向代理 WebSocket 配置、后端启动命令、Vite 启动命令
- **影响范围**: `backend/app/api/v1/stream.py`、`backend/app/core/streaming/session.py`、`frontend/desktop/src/services/audio.ts`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-fix-websocket-connection-timeout.md)

## [2026-06-20] 修复实时识别握手并重排识别预览

- **类型**: fix / refactor / docs
- **描述**: 修复 Uvicorn 热重载工作子进程退出后只剩监听父进程导致 HTTP/WS 全部超时的问题，后端改用无 reload 运行方式；`/v1/stream` 和实时 TTS WebSocket 在接受连接后将首次 FireRed VAD/session 初始化移到工作线程，避免阻塞事件循环并触发前端 5 秒握手超时。桌面实时 ASR 会依次尝试显式后端 WebSocket 和 Vite 同源 `/v1` 代理，只有全部失败才显示包含实际地址的诊断。语音识别页面按 ImageGen 布局参考改为单列宽卡片，将识别预览移动到上传区下方，识别设置和助手继续排列在其后。
- **影响范围**: `backend/app/api/v1/stream.py`、`backend/app/api/v1/tts_api.py`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/Transcribe.tsx`、`frontend/desktop/src/styles/global.css`、`doc/desktop/SPEECH_RECOGNITION.md`、`doc/asrapp/asr/STREAMING.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-fix-realtime-websocket-and-transcribe-layout.md)

## [2026-06-20] 修复录音识别并增加麦克风音频中转混音

- **类型**: fix / feat / docs
- **描述**: 修复删除说话人分离字段后，现有 SQLite `asr_tasks.diarize_enabled NOT NULL` 与 ORM 不兼容，导致录音上传在创建任务时返回 500/`Failed to fetch` 的问题；该列仅作为数据库兼容字段保留并固定写入 `false`。桌面变声器/TTS 新增共享麦克风音频中转：启用后由一个真实麦克风采集流常态透传到当前输出设备，录音和实时 ASR 复用克隆轨道，音效、普通 TTS 和流式 PCM TTS 注入同一个 Web Audio 混音总线，可统一送往 VB、BlackHole 等虚拟声卡。
- **影响范围**: `backend/app/db/`、`backend/tests/test_api.py`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/Transcribe.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/styles/global.css`、`doc/desktop/`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-fix-recording-fetch-and-audio-relay-mixer.md)

## [2026-06-20] 桌面语音识别确认、任务遥测与 X-ASR 多窗口

- **类型**: feat / fix / refactor / docs
- **描述**: 桌面“文件转写”统一改名为“语音识别”，文件选择/拖放后增加确认步骤并删除“最近任务”卡片；标点恢复由占位透传改为懒加载 FunASR CT-Punc；删除说话人分离的桌面开关、请求/响应字段、任务调用链和后端占位文件；开发调试台新增文件 ASR 与实时 VAD→ASR→TTS 任务 trace 瀑布图，覆盖 ASR 首 token、TTS 首个可播放 token/chunk、完成和播放提交；模型管理新增 160/480/960/1920 ms X-ASR 单选切换，并从 Hugging Face 下载四套官方权重。
- **影响范围**: `frontend/desktop/src/`、`backend/app/api/v1/`、`backend/app/core/pipeline/post/`、`backend/app/core/asr/engines/x_asr.py`、`backend/app/schemas/`、`backend/tests/`、`scripts/verify_x_asr_cuda.py`、`doc/desktop/`、`doc/asrapp/`
- **测试报告**: [专项测试报告](reports/2026-06-20-desktop-asr-confirm-punctuation-telemetry-xasr-variants-test-report.md)
- **Plan**: [链接到 plan 文件](plans/2026-06-20-desktop-asr-confirm-punctuation-telemetry-xasr-variants.md)

## [2026-06-20] 修复模型管理 AbortError 并跑通 X-ASR CUDA

- **类型**: fix / chore / docs
- **描述**: 修复模型管理 `/v1/models` 的 8 秒无 reason abort：刷新请求改为单一 controller，新刷新只取消旧刷新，页面卸载/替代取消不再弹错，20 秒超时显示明确后端提示，调试台把正常取消记录为 info。模型加载/卸载期间锁定全部模型操作，避免多个 GPU 模型并发加载。清理 `.env` 中 FireRed、Whisper、SenseVoice 的旧 CPU 覆盖，五个 ASR 默认设备统一为 CUDA。安装官方 `sherpa-onnx 1.13.2+cuda12.cudnn9`，补齐 CUDA/cuDNN 动态库预加载和 Miniconda libstdc++ ABI 兼容，禁止 CPU wheel 静默冒充 CUDA。RTX 5070 Ti 实测加载增加 1359 MiB 显存，6.8 秒音频产生 23 partial、1 final。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/telemetry.ts`、`backend/app/core/asr/engines/x_asr.py`、`backend/app/config.py`、`scripts/`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-fix-model-refresh-abort-and-xasr-cuda.md)

## [2026-06-20] ASR 双通路、离线热词、远程 TTS 与开发调试台

- **类型**: feat / refactor / fix / docs
- **描述**: 离线 ASR 与 X-ASR 实时流式模型改为同时配置，全部 ASR 初始设备为 CUDA；实时字幕和免按键对话统一使用 X-ASR 原生 online stream，删除录音分块调用离线识别和 final 离线精修。删除多模型合并策略及前后端字段。离线转写新增 CapsWriter 风格热词、别名/黑名单、拼音近似和正则规则动态加载。Higgs TTS 新增本地/Boson 远程切换、Token 代理与连接检查。文件转写录音栏保持同排，并新增全局开发调试台统计 HTTP、WebSocket、ASR 首字/final、TTS 首包/总耗时。
- **影响范围**: `backend/app/core/asr/`、`backend/app/core/streaming/`、`backend/app/api/v1/`、`frontend/desktop/src/`、`backend/tests/`、`doc/`
- **测试报告**: [2026-06-20 测试报告](reports/2026-06-20-asr-hotwords-remote-tts-debug-test-report.md)
- **Plan**: [链接到 plan 文件](plans/2026-06-20-asr-stream-hotwords-remote-tts-debug.md)

## [2026-06-20] 启动桌面前端开发环境

- **类型**: chore
- **描述**: 检查本地后端与 Vite 端口，启动 `frontend/desktop` 的 Vite + Electron 开发环境并验证页面连通性；不涉及业务代码变更。
- **影响范围**: `frontend/desktop` 开发进程、运行文档
- **Plan**: [链接到 plan 文件](plans/2026-06-20-open-desktop-frontend.md)

## [2026-06-20] 新增 X-ASR 真流式模型与离线/流式模式选择

- **类型**: feat / docs
- **描述**: 将 `thirdparty/X-ASR` 的 X-ASR-zh-en 160 ms Zipformer 注册为 `x-asr`，通过 sherpa-onnx 为每句话维护独立 online stream，连续 PCM 块直接产生 partial，VAD 结束后复用同一状态产出 final。模型文件已下载并校验，真实录音已产生多个 partial 和一个 final；后续双通路重构已移除 final 离线精修。
- **影响范围**: `backend/app/core/asr/`、`backend/app/core/streaming/session.py`、`backend/app/core/model_manager.py`、`backend/app/api/v1/models.py`、`backend/app/config.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/store/useASRStore.ts`、`thirdparty/X-ASR/`、`pyproject.toml`、`doc/asrapp/asr/`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-x-asr-streaming-model.md)

## [2026-06-19] 变声器音色即时切换、partial 低延迟 TTS 与音效播放

- **类型**: feat / fix
- **描述**: 修复 `变声器/TTS` 页面内切换音色不生效的问题，音色下拉现在会同步写入全局 TTS 设置，文本 TTS、语音转 TTS 和实时 ASR+TTS 会立即使用当前音色。实时 ASR+TTS 不再等整句 final 才触发 TTS，首个非空 `partial` 会 speculative 启动 Higgs 流式 TTS，final 只在没有 partial TTS 时兜底；前端 PCM 采集块降到 512 frame，实时 Higgs `initial_codec_chunk_frames` 使用 0。新增音效区，支持导入多个音频并一键播放到当前输出设备或 VB 等虚拟声卡。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/app/config.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-voicechanger-voice-low-latency-sfx.md)

## [2026-06-19] 修复公网 TTS WebSocket 诊断并对齐 Higgs 流式 PCM

- **类型**: fix
- **描述**: 对比 staged/unstaged 后确认公网后端 `your-server-ip:18000` 的 HTTP 与 `/v1/tts/higgs/stream` WebSocket 均可连通；前端 TTS WebSocket 失败提示不再固定误导为后端监听或防火墙问题，改为列出实际尝试 URL，并提示 HTTPS 页面连接 `ws://` 的 mixed content 或代理 Upgrade 问题。后端 Higgs 流式代理按 `higgs-audio/webui.py` 对齐 `stream=true`、`response_format=pcm`、32768 chunk、`x-sample-rate`、`x-channels`、`x-bit-depth` 与 16-bit 对齐。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`frontend/desktop/src/services/audio.ts`、`backend/tests/test_higgs_tts_api.py`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-fix-public-websocket-higgs-stream.md)

## [2026-06-19] 实时 ASR+TTS 增加流式首包延迟

- **类型**: feat
- **描述**: `WS /v1/tts/higgs/stream` 的实时 TTS 路径默认向 Higgs 发送 `stream=true`，后端按音频 chunk 转发 `tts_start`、`tts_chunk`、`tts_done` 事件，并保留完整 `tts` 事件兼容旧前端。桌面端实时模式新增 PCM chunk 播放器，展示 TTS 首包、端到端首包、TTS 完成和后端总计，用于验证实时 ASR+流式 TTS 是否达到 1 秒内首包目标。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`backend/tests/test_higgs_tts_api.py`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-realtime-asr-tts-latency-streaming.md)

## [2026-06-19] 修复 TTS 参考音频 Data URL 转换

- **类型**: fix
- **描述**: 修复“当前 ASR 生成并填充”仍提示 `Failed to fetch` 的问题。根因是前端在调用 ASR 前用 `fetch(dataUrl)` 把参考音频 Data URL 转 Blob，部分浏览器/Electron 环境会直接拦截 `data:` fetch。现在改为本地解析 Data URL/base64，不触发网络请求，再复用 `/v1/transcribe` 生成预填充文本。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-fix-reference-prefill-data-url-fetch.md)

## [2026-06-19] TTS 参考文本预填充改用通用 ASR

- **类型**: fix
- **描述**: `模型管理 -> TTS 模型设置` 中“当前 ASR 生成并填充”不再调用独立 `/v1/tts/higgs/reference-asr`，改为直接复用桌面端已有 `/v1/transcribe` 接口。参考音频按当前 ASR 引擎和语言转写，兼容同步结果和异步任务轮询，再把 `full_text` 填入“参考音频准确文本”框。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-use-transcribe-for-tts-reference-prefill.md)

## [2026-06-19] 统一 TTS 音色目录

- **类型**: fix / chore
- **描述**: 将旧版 `data/higgs_voice_presets.json` 中的音色迁移到统一目录 `data/tts/voices/<id>/`，当前已有 `default`、`Elysia`、`maoli` 都位于该目录。后端读取音色时会自动把旧 JSON 中尚未目录化的条目写入目录，并清空旧 JSON，接口对外只以目录音色库为准。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`data/tts/voices/`、`data/higgs_voice_presets.json`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-unify-tts-voices-directory.md)

## [2026-06-19] 修复 TTS 参考音频 ASR Failed to fetch

- **类型**: fix
- **描述**: 修复 `模型管理 -> TTS 模型设置` 中“当前 ASR 生成并填充”在 Electron/file 场景或公网 IP 前后端跨端口访问时容易出现 `Failed to fetch` 的问题。空后端地址在 `file:` / `app:` 页面下会回落到 `http://localhost:8000`；后端 CORS 正则新增公网 IPv4 来源支持；参考音频 ASR 请求失败时会显示实际请求地址和配置建议。
- **影响范围**: `frontend/desktop/src/services/api.ts`、`backend/app/main.py`、`backend/tests/test_cors.py`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-fix-tts-reference-asr-failed-fetch.md)

## [2026-06-19] TTS 参考音频支持录音与 ASR 填充

- **类型**: feat
- **描述**: 桌面端 `模型管理 -> TTS 模型设置 -> 上传 / 保存音色` 中，参考音频除了上传文件外新增录音输入；停止录音后自动写入参考音频并可直接播放检查。“当前 ASR 生成并填充”按钮会调用现有 `/v1/tts/higgs/reference-asr`，把当前参考音频识别结果直接填入“参考音频准确文本”框。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-tts-reference-audio-recording-asr-fill.md)

## [2026-06-19] 补齐 TTS/ASR 模型管理残留

- **类型**: fix / docs
- **描述**: 将 TTS 上传弹窗文案进一步收窄为“上传 / 保存音色”，保留常用音色、句首控制标签和生成参数在外层；变声器的一句话“语音转 TTS”改为前端录完整音频后走 `/v1/tts/higgs/audio-to-speech`，避免 WebSocket VAD final 时序导致不可用；变声器刷新运行环境时同步后端已保存音色，便于临时切换；源码层面删除未注册的 Vosk、Sherpa 和 Stream stub ASR 引擎文件。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`backend/app/core/asr/engines/`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-tts-asr-model-management-completion.md)

## [2026-06-18] 优化 TTS 与 ASR 模型管理

- **类型**: feat / fix
- **描述**: 重构桌面端 TTS 模型设置，将当前音色、句首控制标签和生成参数移出弹窗，弹窗聚焦上传/保存音色；音色改为保存到 `data/tts/voices/<id>/` 并支持参考音频播放和当前 ASR 自动生成参考文本；修复语音转 TTS 停止录音时过早关闭 WebSocket 导致收不到 TTS 的问题；实时 ASR+TTS 改用更小 PCM 块和二进制 WebSocket 帧降低前端传输延迟，并保留输出设备选择；变声器/TTS 增加本次使用音色选择；前后端移除 Vosk、Sherpa、Stream 入口；ASR 模型管理支持展开子模型配置启动设备和参数；后端地址支持 `your-server-ip:18000` 这类无协议公网地址；前端移除事件检测入口。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/app/api/v1/models.py`、`backend/app/core/asr/registry.py`、`backend/app/core/model_manager.py`、`backend/app/config.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/App.tsx`、`frontend/desktop/src/components/Sidebar.tsx`、`frontend/desktop/src/components/Toolbar.tsx`、`frontend/desktop/src/styles/global.css`、`backend/tests/test_higgs_tts_api.py`、`backend/tests/test_engines.py`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-tts-asr-model-management-optimization.md)

## [2026-06-18] 整理非核心文件到 tmp

- **类型**: chore / docs
- **描述**: 新增项目本地 `tmp/` 归档目录并加入 `.gitignore`，将旧版散落文档、外层总仓归档、文档站生成/缓存产物、根目录样例音频和 Python 构建/缓存产物移入 `tmp/`；同时清理文档站导航与旧链接，保留被 `CHANGELOG` 引用的任务 plan 到 `doc/plans/`。
- **影响范围**: `.gitignore`、`tmp/`、`doc/README.md`、`doc/index.md`、`doc/.vitepress/config.mts`、`doc/asrapp/`、`doc/desktop/README.md`、`doc/plans/`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-project-tmp-cleanup.md)

## [2026-06-18] 配置 VS Code preview 文件打开行为

- **类型**: chore / docs
- **描述**: 新增工作区级 VS Code 设置，让资源管理器单击文件时使用 preview 临时标签，继续单击其他文件会复用该标签，双击文件后固定为常规标签页。
- **影响范围**: `.vscode/settings.json`、`doc/development/README.md`、`doc/README.md`、`doc/.vitepress/config.mts`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-vscode-preview-open-mode.md)

## [2026-06-18] 合并外层 doc 到 asrapp 项目文档

- **类型**: docs
- **描述**: 将 `~/AI/doc` 合并迁入 `~/AI/asrapp/doc`。因目标目录已有近期 asrapp 文档、TTS 说明和多个 plan，本次采用合并而非替换：保留现有 `README.md`、`CHANGELOG.md`、桌面端文档和近期计划；迁入外层 VitePress 配置、`asrapp/` 完整文档树、历史 plan、文档站 package 文件，并将外层总仓 README/CHANGELOG 归档到 `doc/archive/root-doc/`。
- **影响范围**: `doc/`、`doc/.vitepress/config.mts`、`doc/asrapp/`、`doc/archive/root-doc/`、`doc/plans/`、`.gitignore`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-merge-root-doc-into-asrapp.md)

## [2026-06-18] TTS 设置弹窗化并新增后端音色库

- **类型**: feat
- **描述**: 桌面端 `模型管理 → TTS 模型设置` 改为紧凑摘要 + 弹窗配置，避免所有 Higgs 参数默认全展开。弹窗支持输入音色名、上传参考音频、填写参考音频链接、准确文本和 Code JSON，并调用后端永久保存本地音色 preset。后端新增本地 Higgs 音色库，`voices` 会合并远端音色和本地保存音色；TTS 请求只传保存过的音色名时，也会自动套用后端保存的参考音频/文本/Code JSON。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/task-plan-20260618-224101-tts-voice-library.md)

## [2026-06-18] 补全 Higgs TTS 音色与控制参数

- **类型**: feat
- **描述**: 对照 `~/AI/audio/TTS/higgs-audio/webui.py` 补全桌面端 `模型管理 → TTS 模型设置`：新增参考音频 Data URL、参考音频 URL、参考文本、`reference_codes`、句首情绪/风格/韵律控制标签、`aac` 输出格式和流式首个 codec chunk 帧数。后端 Higgs proxy 现在按 webui 的 payload 规则生成 `references` / `reference_codes` 和控制标签，并让文本 TTS、上传音频 ASR→TTS、实时 ASR+TTS 共用这些持久化设置。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-complete-higgs-tts-model-settings.md)

## [2026-06-18] 修复实时 ASR+TTS 输出音频触发自动停止

- **类型**: fix
- **描述**: 修复实时 ASR+TTS 在一句话 VAD 结束并生成 TTS 后自动中断的问题。根因是 `VoiceChangerPage` 的 URL 清理 effect 依赖 `outputAudioUrl`，每次 TTS 返回音频并更新 URL 时都会执行 cleanup，从而调用 `streamClientRef.current?.stop()` 主动关闭 WebSocket。现在 WebSocket 只在组件卸载或用户手动停止时关闭，实时模式会持续监听并对每一句 final ASR 结果执行 TTS。
- **影响范围**: `frontend/desktop/src/pages/VoiceChanger.tsx`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-fix-realtime-tts-url-cleanup-stop.md)

## [2026-06-18] 桌面端 TTS 模型设置迁移与实时 TTS 修复

- **类型**: feat / fix
- **描述**: 在桌面端模型管理新增 `TTS 模型设置`，集中配置 Higgs API 地址、音色、输出格式和生成参数；变声器/TTS 页面移除模型地址与音色配置入口，仅保留工作台操作和输出设备。实时 ASR+TTS 的 WebSocket 关闭事件现在区分主动停止与异常断开，收到一句话 TTS 后保持实时监听。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/README.md`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-desktop-tts-model-settings-realtime.md)

## [2026-06-18] 修复变声器 WebSocket 连接失败 + ASR CPU 模式

- **类型**: fix
- **描述**: 修复前端变声器 WebSocket connection failed 问题。根因：① ASR 引擎默认配置为 GPU (cuda/cuda:0)，GPU 显存已满 (11.3GB/16GB)，导致模型加载时 OOM；② 前端 WebSocket 客户端错误信息不足，且缺少 URL 校验与连接超时检测。修复后将 SenseVoice Small 和 FireRedASR2 改为 CPU 模式，streaming 的 partial/final ASR 统一使用 sensevoice，同时强化前端 WebSocket 客户端的错误诊断能力。
- **影响范围**: `backend/.env`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`
- **Plan**: [链接](plans/2025-06-18-fix-websocket-cpu-asr.md)

### 变更详情
- `backend/.env`:
  - `DEFAULT_ENGINE`: `fireredasr2` → `sensevoice`
  - 新增 `default_sensevoice_device=cpu`
  - 新增 `default_stream_final_engine=sensevoice`
  - `DEFAULT_FIREREDASR2_DEVICE`: `cuda` → `cpu`
  - `DEFAULT_WHISPER_DEVICE`: `cuda` → `cpu`
- `frontend/desktop/src/services/audio.ts`:
  - `StreamingASRClient` / `VoiceTTSStreamingClient`:
  - 新增 `new URL()` 校验，无效地址提前报错
  - `onerror` 消息现包含实际 URL
  - 新增 5s 连接超时检测
  - fallback `final_engine`: `'fireredasr2'` → `'sensevoice'`
- `frontend/desktop/src/store/useASRStore.ts`:
  - `defaultEngine`: `'fireredasr2'` → `'sensevoice'`
  - `selectedEngines`: `['fireredasr2']` → `['sensevoice']`
  - `normalizeSettings()` 新增强健性：空 URL/无协议前缀 URL 自动重置为默认值，去除末尾斜杠；早期曾把过期远程地址迁移到本地默认地址，该行为已在后续公网测试支持中取消
- `frontend/desktop/vite.config.ts`:
  - 新增 Vite proxy — `/v1` 转发到 `http://localhost:8000`（含 WebSocket），绕过 WSL2 localhost 转发问题
- `frontend/desktop/src/pages/VoiceChanger.tsx`:
  - 组件挂载时 `console.log` 输出版本和服务 URL，方便诊断

## [2026-06-17] 桌面端 Higgs TTS 与变声器工作台

- **类型**: feat
- **描述**: 新增桌面端变声器/TTS 工作台，支持 Higgs v3 文本 TTS、后端 VAD→ASR→TTS 组合 WebSocket、上传音频 ASR→TTS、实时 ASR→TTS、环节延迟展示和音频输出设备选择。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`、`frontend/desktop/src/components/Sidebar.tsx`、`backend/tests/test_higgs_tts_api.py`、`scripts/verify_higgs_tts_e2e.py`
- **Plan**: [链接到 plan 文件](plans/2026-06-17-desktop-higgs-tts-voice-changer.md)
