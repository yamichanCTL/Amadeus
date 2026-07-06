# 桌面总结、文本回填、生命周期与长音频修复计划

> **父文档**: [开发计划索引](README.md)
> **相关模块**: [桌面端总览](../desktop/README.md)

## 任务目标

一次性闭环以下桌面端行为：已生成当日总结随选择直接显示；快捷 ASR 可填入 Amadeus 自身输入框；关闭方式可记忆且与设置使用同一状态；LLM 默认自定义且地址、模型为空并持久化；离线识别结果浮窗复制或关闭后都消失；长音频异步识别不再被 20 秒轮询/执行超时提前终止；实时字幕可拖动；移除 Electron 主线程同步剪贴板写入；当日总结默认所有类型、结束时间 23:59、日期在进入页面和跨日后同步当天。

## 影响范围

- `frontend/desktop/src/pages/Summary.tsx`：默认日期同步、已生成总结直接显示。
- `frontend/desktop/src/store/useASRStore.ts`：默认 LLM、总结范围、关闭行为记忆及持久化迁移。
- `frontend/desktop/src/services/recordingService.ts`：Amadeus 内部编辑框优先回填和长任务轮询。
- `frontend/desktop/src/components/TitleBar.tsx`、`Settings.tsx`：统一关闭策略。
- `frontend/desktop/electron/main.ts`、preload 与覆盖层辅助模块：非阻塞剪贴板、结果浮窗关闭、字幕拖动。
- `backend/app/api/v1/transcribe.py`、`backend/app/tasks/asr_task.py`：长音频任务的动态执行预算。
- 对应 Vitest、Electron 单元测试与后端 pytest。

## 实现步骤

1. 先补回归测试，覆盖默认值、自动日志显示、内部输入框回填、关闭策略记忆、复制即关闭、长任务预算和字幕拖动标记。
2. 将关闭行为归一到“每次询问 / 保留后台 / 完全退出”这一用户设置；弹窗的“记住选择”和设置页读写同一持久状态。
3. 在录音开始时捕获 Amadeus renderer 内当前可编辑元素；收到 ASR 后优先按光标位置写入并触发受控组件更新，无法写入时再走跨应用 helper。
4. 删除主进程注入前的 `clipboard.writeText`；复制结果时先通知主进程隐藏浮窗，再在覆盖层 renderer 中执行剪贴板写入。
5. 为字幕 HTML 添加原生拖动区域，并继续通过 moved 事件保存位置。
6. 调整总结与 LLM 默认值、跨日同步和日志选择即显示。
7. 长音频异步轮询至少保留 30 分钟等待窗口；后端按音频时长扩大异步任务执行预算。
8. 执行目标测试、TypeScript、Vite 构建、后端测试/编译和文档构建。

## 风险评估

- Windows 剪贴板锁和 UIAutomation 只能由 Windows 真机完全验证；本轮以主线程不再调用同步剪贴板 API、快速返回单测和现有 Electron E2E 通路作为自动化证据。
- 长音频真实推理依赖 Celery worker、模型和 GPU；本轮覆盖路由、任务预算与前端轮询链路，若环境缺少 GPU 则不把真实推理标为通过。
- renderer 内部回填必须触发 React `input` 事件，否则受控 textarea 会回滚；测试需直接覆盖光标插入和事件更新。
- 迁移旧设置时，历史 `keepRunningInBackground=true` 迁移为已记忆“保留后台”，false 保持“每次询问”，避免替老用户默默记住完全退出。
