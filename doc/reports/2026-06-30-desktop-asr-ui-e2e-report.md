# 桌面 ASR 交互与自适应 UI 验证报告

> **父文档**: [← 返回桌面端总览](../desktop/README.md)
> **实现计划**: [桌面端 ASR 交互与自适应布局修复](../plans/2026-06-30-desktop-asr-ui-polish.md)

## 验证范围

本报告覆盖 2026-06-30 的桌面端 UI、自动润色回填、复制、窗口尺寸、图标、统一润色/翻译设置和录音浮层控制。验证环境为 Linux + Xvfb 的 Electron 31 生产构建，同时执行 Windows x64 交叉打包；Windows UIAutomation 与真实 DJI/CABLE 音频设备只在 Windows 真机脚本中验收。

## 需求逐项结果

| # | 需求 | 实现与证据 | 结果 |
| --- | --- | --- | --- |
| 1 | 删除无功能人物区域 | `TranscribePage` 删除 `AssistantFigure`/气泡及对应 CSS；1366×900、760×720 截图只保留可操作设置 | 通过 |
| 2 | 离线润色结果自动填充 | `selectDeliveryText()` 优先选择启用项对应的 `llm_outputs`；`recordingService.consecutive.e2e.test.ts` 完整执行 `runTranscription → deliverResult → injectText`，断言注入“自动润色后的回填结果”而非原文 | 通过 |
| 3 | 初始非全屏覆盖完整侧栏 | `calculateInitialWindowBounds()` 使用完整 workArea 高度；1920×1040 得到 1728×1040，1280×680 不越界 | 通过 |
| 4 | 分辨率变化不重叠 | 侧栏在 1320px 折叠，历史页以 1080px 容器断点控制双/单栏，筛选器换行；Electron DOM 检查见下表 | 通过 |
| 5 | 复制卡顿 5–10 秒 | renderer 改用单向 IPC，主进程直接写系统剪贴板；生产 Electron E2E 实测调用耗时 0 ms，标记文本读回一致，门槛 50 ms | 通过 |
| 6 | 最小化按钮位置 | 下划线字符改为居中的 10×1 CSS glyph，窗口按钮使用固定 46px 点击区；多尺寸截图标题栏位置一致 | 通过 |
| 7 | 任务栏/安装包图标 | 主窗口和托盘优先加载 512×512 PNG；设置 `com.asrapp.desktop` AppUserModelId；electron-builder 启用资源编辑并实际执行 `rcedit --set-icon .../icon.ico` | 打包通过；Windows 任务栏真机待复核 |
| 8 | 合并润色和翻译 | 模型管理只保留“润色/翻译设置”，共用厂商、地址、模型、Token 和 Prompt；结果操作/页签统一命名；store v34 迁移旧翻译配置 | 通过 |
| 9 | 语音框增加 X/勾 | 260×42 浮层左右提供 `×` 取消、`✓` 提交；生产 E2E 点击后主进程计数 `cancel 0→1`、`submit 0→1` | 通过 |
| 10 | 优化 README | 参考 Open WebUI、faster-whisper、whisper.cpp 的 README 信息层级，重写定位、能力、快速开始、架构、验证和文档导航；VitePress 构建通过 | 通过 |

## 响应式 Electron E2E

| Viewport | 文档宽度 | 历史页列 | 列表/详情重叠 |
| --- | ---: | --- | --- |
| 1280×720 | 1280 | 486.438px + 594.562px | 否 |
| 1280×960 | 1280 | 486.438px + 594.562px | 否 |
| 720×520 | 720 | 615px 单列 | 否 |

截图生成器还验证了 1366×900 和 760×720 的语音识别页，五档结果均满足 `documentElement.scrollWidth === innerWidth`。

## 浮层与复制 E2E

- 录音浮层：260×42，主显示器水平居中，位于工作区下半部。
- `×` / `✓` 均存在并真实发送 overlay→main→renderer IPC。
- Thinking 文本循环正常；结果浮层 360×64，结果文本、复制和关闭均通过。
- 复制快速通道：renderer 调用 0 ms；系统剪贴板读回与写入标记一致。
- 字幕浮层：文本、设置、关闭及主窗口设置页跳转均通过。

生产 E2E 原始报告位于本次环境的 `/tmp/amadeus-main-e2e-controls/e2e/result.json`；截图位于同目录。该 `/tmp` 证据不提交到仓库。

## 构建与测试

- Desktop Vitest：15 files / 61 tests 全量通过。
- Renderer TypeScript：通过。
- Electron TypeScript：通过。
- Vite production build：通过。
- Windows x64 directory package：PNG 成功转换为 64,081-byte ICO，并由 Wine/rcedit 写入 `Amadeus.exe`；最后一轮 CSS 细调后的重打包被执行权限用量上限拒绝，因此最终源码仍需在 Windows 构建机执行一次 `npm run build:win`。
- Python `compileall backend/app`：通过。
- VitePress build：通过。
- 后端 `test_transcribe_auto_llm_success` 在当前环境 45 秒内无输出并被 `timeout` 终止（exit 124）；本次未修改后端 LLM 逻辑，不将该项计为通过。

## 平台边界

Linux E2E 总报告的全局 `passed` 为 false，因为 Windows UIAutomation helper、Windows 前台窗口注入以及 DJI MIC MINI / CABLE Input / CABLE Output 不存在。平台无关的品牌、用户 ID、响应式布局、系统剪贴板、录音/结果浮层和字幕浮层均实际通过。Windows 真机最终验收命令：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/run_amadeus_windows_e2e.ps1
```

---

> 📖 [返回桌面端总览 →](../desktop/README.md)
