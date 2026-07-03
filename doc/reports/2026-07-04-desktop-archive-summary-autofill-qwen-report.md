# 桌面归档、总结来源、结果回填与 Qwen3-ASR 验证报告

> **父文档**: [← 返回桌面端总览](../desktop/README.md)
> **实施计划**: [查看 Plan](../plans/2026-07-04-desktop-archive-summary-autofill-qwen-fixes.md)

## 需求验证

| # | 需求 | 结果 | 自动化证据 |
|---|---|---|---|
| 1 | 实时识别保存音频 | 通过 | 流式客户端收集实际发送的 PCM，关闭会话时生成 RIFF/WAVE；`audio.streaming-recording.test.ts` 和 `liveCaption.persistence.test.ts` 验证 WAV 归档 |
| 2 | 每次总结自动保存，并明确本机/服务端文本来源 | 通过 | 主动与被动总结成功路径均调用本机日志保存；来源选择分别显式发送 `records` 或使用服务端归档；自动保存组件测试通过 |
| 3 | 当日总结 Prompt 卡片 | 通过 | 总结和语音识别复用 `PromptCardEditor`；store 覆盖选择、命名、编辑、新增、删除和旧 Prompt 迁移 |
| 4 | 离线/实时结果自动回填，弹窗复制不冻结主窗口 | 通过（逻辑） | 离线持久状态在外部注入完成前可见；实时 final 立即更新 `currentResult`；复制调度测试确认 handler 返回后才执行 clipboard 工作。Windows 真机时延未在本环境复测 |
| 5 | 模型管理删除重复 LLM 后处理设置 | 通过 | LLM 页只保留 provider、base URL、model、token 和探测操作；源码审计确认三个重复控件不再渲染 |
| 6 | 字幕设置动态更新预览 | 通过（逻辑） | 预览打开后宽度从 760 调为 900 会再次调用 overlay 预览 API；React DOM/IPC 回归测试通过。真实桌面窗口当前截图受环境限制 |
| 7 | 本机归档使用深层目录 | 通过 | 实际临时文件系统测试验证 `wav|json/<识别类别>/<本地 YYYY-MM-DD>/...`，并覆盖非法文件名、类别和扩展名清理 |
| 8 | Qwen3-ASR 结果可 JSON 持久化 | 通过 | fake `ASRTranscription` 经实际 Qwen adapter 与 `create_transcript` 持久化链路验证；递归对象也有回归覆盖 |

## 自动化结果

- Desktop Vitest：29 files / 94 tests passed。
- Renderer TypeScript：`tsc --noEmit` passed。
- Electron TypeScript：`tsc -p tsconfig.node.json --noEmit` passed。
- Vite production build：82 modules transformed，passed。
- Backend Qwen JSON 定向测试：4 passed。
- Backend Python：`compileall backend/app` passed。
- VitePress：production build passed。
- 工作树检查：`git diff --check` passed。

## 验证边界

本轮尝试启动 Electron 当前页面截图，但执行申请被环境的审批额度拒绝，不能重试规避。因此当前 UI 改动只计 React DOM、IPC、TypeScript 和 Vite 构建通过；不使用 2026-07-03 的旧截图冒充本轮动态字幕或复制路径证据。Windows UIAutomation 真实输入、剪贴板时延和原生字幕窗口实时尺寸仍需 Windows 真机 E2E。

---

> 📖 [返回桌面端总览 →](../desktop/README.md)
