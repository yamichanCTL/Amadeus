# 润色归档、全部类型总结与紧凑初始窗口 Plan

> **父文档**: [← 返回计划索引](README.md)
> **相关文档**: [当日总结与数据留存](../desktop/SUMMARY_PRIVACY_AND_LIFECYCLE.md) · [输入与窗口](../desktop/INPUT_AND_OVERLAYS.md)

## 任务目标

1. 同步与异步离线 ASR 归档 JSON 保存 AI 润色结果，指定归档文件类型可直接看到处理后的文本。
2. 总结类型增加 `Both / 所有类型`，可同时汇总离线识别与实时识别。
3. 缩小 Electron 首次打开窗口，不再使用接近全屏的 90% 宽度和完整工作区高度。
4. 总结请求只从归档中提取开始时间、结束时间和 AI 润色后的文本标签，不把原始 ASR 和其他 JSON 元数据发送给 LLM，以减少输入 token。

## 影响范围分析

- 后端归档：`backend/app/core/archive.py`、`backend/app/api/v1/transcribe.py`、`backend/app/tasks/asr_task.py`。
- 总结提取：`backend/app/core/archive.py`、归档/总结定向测试。
- 桌面总结：`frontend/desktop/src/pages/Summary.tsx`、`App.tsx`、`useASRStore.ts`。
- 初始窗口：`frontend/desktop/electron/window-layout.ts` 及其测试。
- 文档：总结/隐私专题、输入与窗口说明、CHANGELOG、验证报告。

## 实现步骤

1. 为归档 JSON 增加稳定的 `llm_outputs` 与 `ai_polished_text` 字段，调用方传入去除 Token 后的 LLM 输出。
2. 总结提取优先使用 `labels.ai_polished` / `llm_outputs.polish.text`；实时记录没有润色结果时回退其 ASR label。每行只包含 `[开始-结束]` 和一个 label，不发送原始 JSON 元数据；Both 仅遍历 ASR 类别。
3. `category` 为空时复用现有跨目录查询，前端增加 `Both / 所有类型` 选项并允许被动总结持久化空值。
4. 初始窗口改为受最小尺寸和工作区约束的紧凑居中窗口，补 1920×1040 与 1280×680 回归断言。
5. 运行后端定向测试、Desktop Vitest、两套 TypeScript、Vite、compileall、VitePress 和 diff check。

## 风险评估

- 旧离线归档没有 AI 润色字段时只能回退原始 ASR label；新归档会优先发送 AI 润色 label。所有情况下都只发送时间与一个 label，不发送完整 JSON。
- `Both` 使用 `category` 缺省语义，会遍历当日全部类别；必须排除“当日总结”等非 ASR JSON，只有含 AI 润色字段的记录才会进入输入。
- 窗口不能小于 Electron 的 `720×520` 最小限制；低分辨率屏幕仍会受工作区约束。
- 当前已有 staged 用户改动（含长 Prompt 与截图脚本）必须原样保留，本轮只叠加相关修复。
