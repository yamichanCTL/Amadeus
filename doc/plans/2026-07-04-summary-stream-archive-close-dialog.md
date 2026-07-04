# 桌面总结全流式、同目录归档与关闭选择恢复 Plan

> **父文档**: [返回计划索引](README.md)
> **相关文档**: [桌面端总览](../desktop/README.md) · [总结与数据生命周期](../desktop/SUMMARY_PRIVACY_AND_LIFECYCLE.md) · [语音识别](../desktop/SPEECH_RECOGNITION.md)

## 任务目标

1. 修复当日总结配置区横向溢出和结果区信息组织问题，并支持列出、读取和显示已经生成的本机 Markdown 总结。
2. 主动总结改用后端 NDJSON 流接口；模型输出到达后立即更新结果区，直到完成后再自动保存最终 Markdown。
3. 音频与对应 JSON 改为同一类别、日期目录中的同名文件，不再拆到 `wav/` 和 `json/` 两棵目录。
4. 实时对话的单次语音 ASR 完成后先自动填入本软件输入框，允许编辑后再发送；免按键模式继续按既有约定自动对话。
5. 恢复点击标题栏 X 时的关闭选择：本次保留后台、完全退出或取消；设置中的默认偏好继续保留，但不替代显式选择。

## 影响范围分析

- 总结 UI/客户端流：`frontend/desktop/src/pages/Summary.tsx`、`services/api.ts`、`styles/global.css`。
- 总结日志读取：`electron/main.ts`、`preload.ts`、`src/vite-env.d.ts`、`services/summaryLog.ts`。
- 归档布局：`electron/archive-layout.ts` 与对应测试和文档。
- ASR 输入回填：`pages/RealtimeAgent.tsx`，抽取可独立测试的 prompt 回填规则。
- 关闭选择：`components/TitleBar.tsx`、Electron IPC 和关闭决策测试。
- 后端总结：`backend/app/core/llm.py`，多分块压缩也通过流式 provider 调用消费，持续向客户端发送阶段状态。
- 文档：CHANGELOG、桌面总结/识别专题和专项验证报告。

## 实现步骤

1. 增加失败回归：流式总结事件解析与增量 UI、总结日志列表读取、同目录归档、ASR 回填规则、关闭选择。
2. 增加 `streamArchiveSummary`，逐行解析 NDJSON `meta/status/delta/done/error`；Summary 页面边接收边渲染，并只在 `done` 后保存最终结果。
3. 在 Electron 主进程限制于 `summary-logs/<date>` 下列出 Markdown，返回文件名、路径、修改时间和正文；页面提供刷新与加载入口。
4. 将归档布局改为 `<root>/<类别>/<日期>/<同一 stem>.<audio ext|json>`，保持文件名清理和路径穿越防护。
5. 单次语音 ASR 使用纯函数合并到当前输入框，不再直接触发 Agent 请求；补充清晰的输入提示。
6. 标题栏关闭按钮先打开模态选择；显式 IPC 分别执行隐藏或退出，取消不改变窗口状态。
7. 调整总结页列宽、Prompt 编辑器容器响应式和历史总结工具栏，消除截图中的覆盖/截断。
8. 运行目标测试、完整 Vitest、TypeScript、Vite、后端测试/compileall、VitePress；启动桌面页面并采集当前截图核验。

## 风险评估

- **流式中断**：收到部分文本后失败时必须保留已显示内容并明确错误，不能把半成品自动保存为成功总结。
- **渲染频率**：按 provider delta 更新，不人为等待完整结果；避免逐字符同步阻塞网络读取或大量 localStorage 写入。
- **历史日志安全**：renderer 不接收任意路径读取能力，只能通过主进程列出配置归档根下指定日期的 `.md` 文件。
- **目录兼容**：不移动或删除旧 `wav/`、`json/` 历史；新写入使用同目录布局。
- **关闭语义**：完全退出必须设置强制退出标记，避免再次进入 `close` 拦截；保留后台只隐藏主窗口。
- **验证边界**：Linux 可验证 Electron IPC、页面截图和逻辑；Windows 托盘/任务管理器进程状态仍需真机复验。

## 实施结果

- 主动总结使用 NDJSON 流并逐字符刷新；被动总结也切到同一流端点，多分块压缩和最终生成均使用 provider 流式调用。
- 结果区增加所选日期的本机 Markdown 列表、刷新和加载显示；读取被限制在配置归档根的 `summary-logs/<date>`。
- 新音频和 JSON 写入 `<根>/<类别>/<日期>/<同一 stem>.*`，旧双目录数据保持不动。
- 实时对话单次 ASR 先填入可编辑输入框；标题栏 X 恢复“保留后台 / 完全退出 / 取消”选择。
- 1600×1000 截图复核后把生成按钮前置，并把总结 Prompt 卡片改为紧凑三列，消除参考图中的溢出和首屏操作不可见问题。
