# 桌面总结持久化、Prompt 卡片与分页设置 Plan

> **父文档**: [返回计划索引](README.md)
> **相关文档**: [桌面端总览](../desktop/README.md) · [总结与数据留存](../desktop/SUMMARY_PRIVACY_AND_LIFECYCLE.md)

## 任务目标

1. 当日总结在页面切换后保持范围、运行状态和结果，并把返回的 Markdown 安全渲染为正文。
2. 模型管理的“润色/翻译设置”改名为“LLM 设置”，移除与语音识别页重复的 Prompt 编辑区域。
3. 在语音识别页提供可选择、命名、编辑、保存和新增的 Prompt 卡片；选中卡片后立即成为自动与手动 LLM 处理使用的 Prompt。
4. 新安装默认勾选“实时识别时显示桌面字幕框”，并兼容已有持久化设置。
5. 桌面端不再把用户填写的目录作为服务端上传/归档目录发送；目录设置只代表 Electron 本机保存位置。
6. 当服务端数据留存关闭时，桌面端读取本机同一日期和范围的 ASR 归档，随总结请求发送到后端；后端完成总结后返回结果，用户可选择保存到本机总结日志目录。
7. 将设置页按“常规 / 音频 / 识别与字幕 / 数据与隐私”分页整理，并基于当前截图和 ImageGen 设计参考做视觉复核。

## 影响范围分析

- 桌面状态：`frontend/desktop/src/store/useASRStore.ts`，新增持久化 Prompt 卡片、总结工作区和版本迁移。
- 桌面总结：`frontend/desktop/src/pages/Summary.tsx`、Markdown 渲染组件、Electron 本机归档读取/保存接口。
- 语音识别与模型管理：`Transcribe.tsx`、`Models.tsx`，Prompt 卡片编辑和重复设置清理。
- 设置与样式：`Settings.tsx`、`global.css`，分页、目录文案与只选目录交互。
- 桌面请求：`recordingService.ts`、`RealtimeAgent.tsx`、`Models.tsx`，停止发送前端目录到服务端。
- 后端总结：LLM schema/归档构造/API 测试，允许接收已脱敏的本地记录而不要求服务端留存。
- Electron：主进程、preload 与类型声明，按范围读取本机归档并将总结 Markdown 保存到本机日志目录。
- 文档：桌面使用说明、后端 API、CHANGELOG 和专项验证报告。

## 实现步骤

1. 采集语音识别、模型管理和设置页当前截图；生成一张高保真分页设置与 Prompt 卡片布局参考图。
2. 为 store 迁移、总结跨页保留、Prompt 卡片选择/编辑、Markdown 安全渲染和本地归档摘要输入补充测试。
3. 将总结表单和结果提升到 Zustand 持久状态；总结请求开始/成功/失败均更新 store，页面重新挂载后恢复。
4. 引入本地 Markdown 渲染依赖或小型安全渲染器，禁用原始 HTML，支持标题、列表、强调、代码与表格等常用输出。
5. 新增 Prompt 卡片设置结构和 CRUD；语音识别页承担卡片管理，模型管理只保留供应商、模型、Token、目标语言等 LLM 基础配置。
6. Electron 读取本地归档 JSON，renderer 按日期/时间/类别取得最小化记录，随总结请求发送；后端优先处理显式 records，并继续支持旧的服务端归档查询。
7. 总结本地保存统一写入 Electron 归档根目录下的 `summary-logs/<YYYY-MM-DD>/`，保留“另存为”能力但不强制云端保存。
8. 设置页改为四个页签；本地目录只能通过目录选择器修改，所有桌面 ASR 请求不再携带 `archive_dir`。
9. 运行目标 Vitest/Pytest、TypeScript、Vite、Python compileall、文档构建、`git diff --check`，再采集落地后的 UI 截图逐项对照。

## 风险评估

- **旧数据迁移**：已有 `llmPolishPrompt` 和 `archiveDir` 必须迁移为默认选中卡片与本地目录，不能丢失用户配置。
- **隐私边界**：本机记录只在用户点击生成总结或启用被动总结时发送；payload 只含时间、类别和优先文本，不包含音频路径、Token、设备信息或完整归档 metadata。
- **Markdown 安全**：禁止渲染模型输出中的原始 HTML/脚本；外链需要安全属性。
- **跨平台文件访问**：浏览器测试环境没有 Electron API 时需保持可运行；真实目录读取和保存以 Electron 主进程为准。
- **被动总结**：服务端留存关闭时后台任务同样需要读取本机记录，不能只修主动页面。
- **截图验证**：Linux Electron 沙箱可能限制真实窗口截图；若发生，只把逻辑/构建与脚本生成截图标记为已验证，不声称 Windows 实机视觉通过。

## 实施偏差与决策

- 原计划通过 Electron 重新扫描本机归档 JSON。实际改为使用已经持久化、同时覆盖离线与实时识别的 Zustand `history` 作为总结构造源，并在实时识别结束时补写本机 JSON。这样避免主进程把任意磁盘 JSON 重新暴露给 renderer，同时能够直接按日期、类型和时间筛选；发送字段仍只有时间、类别和文本。
- UI 以 ImageGen 参考图的“卡片选择 + 单一编辑区”和“四页签设置”为布局依据，保留项目现有侧栏、色彩、圆角和 CSS 组件，不把生成图作为运行时资产。
