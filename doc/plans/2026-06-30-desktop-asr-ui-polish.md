# 桌面端 ASR 交互与自适应布局修复 Plan

> **父文档**: [← 返回项目文档索引](../README.md)

## 任务目标

1. 删除语音识别页无实际功能的人物助手区域。
2. 修复启用离线润色/翻译后，自动填充仍使用原始 ASR 文本的问题。
3. 调整桌面窗口初始尺寸，使非全屏窗口基于当前显示器工作区，避免遮挡或被任务栏覆盖。
4. 修复历史记录等页面在不同分辨率、缩放比例和窄窗口下的重叠与溢出。
5. 定位并消除结果复制操作 5–10 秒的界面卡顿，保证剪贴板写入不阻塞渲染线程。
6. 修正自定义标题栏最小化按钮的位置和点击区域。
7. 将 `img/Amadeus/amadeus-icon.png` 用于主窗口、托盘与 Windows 安装包/任务栏图标。
8. 将前端独立的润色与翻译配置合并为“润色/翻译”，以同一模型配置和不同 Prompt 驱动。
9. 在语音输入浮层两侧增加取消与提交按钮，分别中断和提交识别。
10. 参考高 star 开源项目的信息结构优化根 README，并逐项完成可重复的端到端验证。

## 影响范围

- `frontend/desktop/electron/`: 窗口尺寸、图标、标题栏 IPC、语音浮层交互与 Electron E2E。
- `frontend/desktop/src/components/`: 结果面板、标题栏、录音控制与复制反馈。
- `frontend/desktop/src/pages/`: 语音识别、历史记录、模型管理页面。
- `frontend/desktop/src/services/`: 自动增强结果选择、剪贴板快速路径和录音提交/取消控制。
- `frontend/desktop/src/styles/`: 响应式布局、溢出约束和窗口控制区。
- `frontend/desktop/electron-builder.yml`: Windows 打包图标。
- `README.md`、`doc/desktop/`、`doc/CHANGELOG.md`: 使用说明、设计说明和变更记录。

## 实现步骤

1. 将截图问题映射到具体组件与 CSS 断点，保留现有未提交文件。
2. 先增加自动润色回填、剪贴板非阻塞、响应式布局和窗口/浮层控制的回归测试。
3. 统一“润色/翻译”配置：复用大模型连接信息，通过操作 Prompt 区分润色或翻译；迁移旧持久化配置时保持兼容。
4. 自动识别完成后按配置优先选择 `llm_outputs` 增强文本，再进行复制/注入；增强失败时明确回退原文。
5. 删除助手展示区域，重构历史页网格和内容最小宽度，增加分辨率与缩放断点。
6. 按显示器 `workArea` 计算初始窗口尺寸与居中位置；统一任务栏图标；调整标题栏窗口按钮。
7. 将复制写入改成快速 IPC 发送并提供即时状态反馈，避免 `invoke` 往返阻塞 React 事件。
8. 在语音浮层添加取消/提交控制并连接到现有 `recordingService.forceStop/toggle` 流程。
9. 重写 README 的项目定位、能力、快速开始、架构、验证与文档导航。
10. 执行单测、类型检查、Vite/Electron 构建、Electron E2E 截图和差异检查；将环境限制单独记录。

## 风险评估

- **旧配置迁移**：用户可能已有独立翻译服务配置；保留字段读取兼容，在界面和新请求路径中统一配置，避免静默丢失。
- **自动填充语义**：增强接口失败时不能丢失识别结果；使用原文回退并保留错误信息。
- **Windows 行为**：任务栏图标、工作区尺寸和剪贴板卡顿依赖 Windows/Electron；自动化可验证配置与 IPC，真实任务栏表现需以 Windows 打包运行证据为准。
- **窄屏布局**：不能只隐藏内容；所有网格子项必须设置 `min-width: 0`，控制区允许换行，并以多个 viewport 做截图检查。
- **录音控制竞态**：取消与提交可能与识别响应同时发生；复用单例服务的 abort/状态机，避免另建并行录音状态。

## 验收标准

- 10 项需求各有代码路径和自动化/构建/截图证据。
- 自动润色/翻译开启时，自动填充文本等于对应增强结果；关闭时为原文。
- 复制点击后 UI 立即响应，IPC 不等待耗时 Promise。
- 1280×720、1280×1024 和窄窗口下历史页无内容覆盖。
- Electron E2E 可触发录音浮层取消/提交，窗口配置和图标路径有效。

## 执行结果与偏差

- 代码、文档、61 项桌面测试、两套 TypeScript、Vite、VitePress、Python compileall、Linux/Xvfb Electron E2E 与 Windows 真机 E2E 均已完成。
- 最终 Windows 包内 `dist/index.html`、`dist-electron/main.js`、`dist-electron/e2e.js` 与当前构建产物哈希一致；64,081-byte ICO 已由 rcedit 写入 `Amadeus.exe`。
- Windows 真机报告全局 `passed: true`：三档历史布局无溢出/重叠，系统剪贴板调用 0.1 ms，真实 UIAutomation 连续第二次注入 128.1 ms，录音浮层取消/提交 IPC 均为 `0→1`，DJI MIC MINI 采集 1.152 秒且 gap/overlap 均为 0。
- Windows Shell 视觉证据确认初始窗口覆盖 2560×1392 工作区高度、完整显示侧栏，任务栏按钮和 EXE 关联图标均为 `amadeus-icon.png` 对应头像。
- 后端 `test_transcribe_auto_llm_success` 在解除受限环境对 aiosqlite 工作线程唤醒的限制后 0.64 秒通过；前端完整 `runTranscription → deliverResult → injectText` 集成测试确认最终注入增强文本而非 ASR 原文。
