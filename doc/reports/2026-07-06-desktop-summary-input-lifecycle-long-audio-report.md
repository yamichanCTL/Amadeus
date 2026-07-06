# 桌面总结、ASR 回填、关闭策略与长音频验证报告

> **父文档**: [← 返回桌面端总览](../desktop/README.md)
> **实施计划**: [查看 Plan](../plans/2026-07-06-desktop-summary-input-lifecycle-long-audio.md)

## 需求验收

| # | 需求 | 结果 | 自动化证据 |
|---|---|---|---|
| 1 | 已生成当日总结无需二次确认 | 通过 | 日志读取后自动渲染最新 Markdown，下拉切换立即更新；组件回归通过 |
| 2 | ASR 自动填入本软件输入框 | 通过（逻辑） | 录音开始捕获当前 input/textarea 与光标选区；原生 DOM 与 React 受控 textarea 回归均通过 |
| 3 | 关闭方式可记忆且不与设置冲突 | 通过 | 弹窗“记住选择”和设置页三态策略共用同一 store；第二次 X 直接复用已记忆动作 |
| 4 | LLM 默认 custom、地址/模型为空并保存 | 通过 | 前后端默认值测试通过；桌面输入继续由 Zustand persist 自动保存 |
| 5 | 结果浮窗复制或 X 后关闭 | 通过（逻辑） | 复制先发隐藏 IPC 再异步写剪贴板；copy/close 两条 main handler 源码回归通过 |
| 6 | 长音频识别 | 通过（链路） | renderer 异步轮询最少 30 分钟；Celery 推理预算随音频时长扩大；定向后端测试通过 |
| 7 | 实时字幕框可移动 | 通过（逻辑） | 字幕正文为 native drag region，按钮为 no-drag；位置仍由 moved 事件持久化 |
| 8 | 剪贴板锁导致 5 秒主线程阻塞 | 通过（架构） | `injectText` 不再调用 main-process `clipboard.writeText`；常驻 STA helper 独立写剪贴板 |
| 9 | 总结默认 both、23:59、当天日期实时更新 | 通过 | store 默认值、跨日本地日期同步与“今天”恢复模式测试/类型检查通过 |

## 执行结果

- Desktop Vitest：37 files / 112 tests 全部通过。
- 新增目标覆盖：总结直接显示、关闭记忆、React Prompt 回填、30 分钟长任务轮询、复制即关闭、字幕 drag region、main process 无同步注入剪贴板。
- Renderer TypeScript：通过。
- Electron TypeScript：通过。
- Vite 生产构建：83 modules transformed，通过。
- Backend 定向 pytest：超时默认/guard、长音频动态预算、LLM custom 空默认共 4 个独立用例通过；数据库 fixture 用例在当前执行窗口未完成，不计入通过。
- Python `compileall`：通过。
- `git diff --check`：通过。

## 环境边界

当前 Linux 工作区不能证明 Windows 上真实第三方程序持有 `OpenClipboard` 锁时的系统级耗时，也不能完成带真实 Celery worker、GPU 模型和长音频素材的计时推理。自动化已经证明 Electron main process 不再接触该同步 API，renderer 不会在 20 秒停止轮询，后端任务预算会按时长扩大；Windows 剪贴板竞争、真实字幕拖动手感和真实长音频 GPU 推理仍应在打包 Windows 环境复验，不能用本轮逻辑测试冒充硬件/系统 E2E。

---

> 📖 [返回桌面端总览 →](../desktop/README.md)
