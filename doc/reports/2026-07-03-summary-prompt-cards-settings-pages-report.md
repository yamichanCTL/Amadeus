# 总结持久化、Prompt 卡片与分页设置验证报告

> **父文档**: [← 返回桌面端总览](../desktop/README.md)
> **实施计划**: [查看 Plan](../plans/2026-07-03-desktop-summary-prompt-cards-settings-pages.md)

## 需求验证

| # | 需求 | 结果 | 证据 |
|---|---|---|---|
| 1 | 切页后保留当日总结并渲染 Markdown | 通过 | `summaryWorkspace` 进入 Zustand 持久状态；导航回归测试通过；截图确认标题、无序/有序列表和强调渲染 |
| 2 | 删除重复 Prompt 设置并改名 LLM 设置 | 通过 | 模型管理页签显示“LLM 设置”，该页不再渲染 Prompt textarea |
| 3 | Prompt 卡片选择、命名、编辑、保存、新增 | 通过 | 语音识别页提供默认三卡、新增/删除、名称和 Prompt 编辑区；store 测试确认选择后立即更新当前 Prompt |
| 4 | 默认显示桌面字幕框 | 通过 | `DEFAULT_SETTINGS.showDesktopCaptions=true`；store 回归测试和设置截图均确认勾选 |
| 5 | 前端只设置本机保存目录 | 通过 | 设置页目录输入只读且只能打开目录选择器；renderer 非测试代码中不再出现 `archive_dir: settings.archiveDir` |
| 6 | 本机记录发送后端总结并保存日志目录 | 通过 | 隐私关闭时请求携带最小化 `records`；后端纯函数验证生成 `[09:10:00-09:11:00] 本机记录`；总结写入 `summary-logs/<日期>/` |
| 7 | 设置分页重做 UI | 通过 | 常规、音频、识别与字幕、数据与隐私四页；Electron 1440×960 截图确认双列分组布局 |

## UI 证据

- [ImageGen 设计参考](../assets/ui/2026-07-03-prompt-cards-settings-pages-reference.png)
- [语音识别 Prompt 卡片](../assets/ui/2026-07-03-transcribe-prompt-cards.png)
- [设置：识别与字幕](../assets/ui/2026-07-03-settings-recognition-page.png)
- [当日总结 Markdown](../assets/ui/2026-07-03-summary-markdown.png)
- [模型管理页签](../assets/ui/2026-07-03-model-management-tabs.png)

截图由本地 Vite + Electron 31 隐藏窗口 `capturePage()` 生成。Linux 环境缺少中文字体，部分汉字显示为方框，但 DOM、布局、控件状态和 Markdown 层级可验证；不据此声称 Windows 字体渲染已实机验收。

## 自动化结果

- Desktop Vitest：22 files / 79 tests passed（其中本次新增/相关目标集为 6 files / 11 tests）。
- Renderer TypeScript：`tsc --noEmit` passed。
- Electron TypeScript：`tsc -p tsconfig.node.json --noEmit` passed。
- Vite production build：81 modules transformed，passed。
- Backend Python：`compileall backend/app` passed。
- Backend 本机 records 纯函数：1 条记录、25 字符、未截断，passed。
- Backend API pytest：目标命令 75 秒无输出后中止，未计为通过；这是环境 fixture 停滞边界，不替代上述 schema/纯函数验证。

---

> 📖 [返回桌面端总览 →](../desktop/README.md)
