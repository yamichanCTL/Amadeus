# 桌面归档、总结来源、结果回填与 Qwen3-ASR 修复 Plan

> **父文档**: [返回计划索引](README.md)
> **相关文档**: [桌面语音识别](../desktop/SPEECH_RECOGNITION.md) · [总结与隐私](../desktop/SUMMARY_PRIVACY_AND_LIFECYCLE.md) · [后端 API](../asrapp/backend/API.md)

## 任务目标

1. 实时识别在本机保存完整音频，而不只保存 JSON。
2. 每次主动或被动总结完成后自动保存 Markdown 日志；显式区分“本机记录”和“服务端归档”两种总结来源，不再由服务端留存开关隐式决定。
3. 当日总结 Prompt 使用与语音识别一致的可选择、命名、编辑、新增和删除卡片机制。
4. 离线/文件/实时识别结果立即回填到软件内结果区；弹窗复制不得阻塞主窗口数秒。
5. 模型管理移除重复的“转写完成后自动执行当前 Prompt 卡片”“目标语言”“风格补充”。
6. 字幕预览打开后，宽度、高度、字号、颜色和透明度等设置变化立即更新预览框。
7. 本机归档改为 `wav|json/<实时识别|离线语音识别>/<YYYY-MM-DD>/...` 层级。
8. 修复 Qwen3-ASR 原始 `ASRTranscription` 对象导致数据库 `json.dumps` 失败的问题，并覆盖同步与异步共用的持久化入口。

## 影响范围分析

- 音频流：`frontend/desktop/src/services/audio.ts`、`liveCaption.ts`，在 WebSocket 发送 PCM 的同时收集本机 WAV。
- Electron 归档：`electron/main.ts`、preload/types，按媒体类型、识别类别和日期分别写入音频/JSON。
- 总结状态/UI：`useASRStore.ts`、`Summary.tsx`、`App.tsx`，增加来源和总结 Prompt 卡片，所有生成成功路径自动保存。
- 结果回填/复制：`recordingService.ts`、`liveCaption.ts`、overlay IPC，确保 store 先更新、复制与主窗口通知解耦。
- 设置/模型管理：`Settings.tsx`、`Models.tsx`，删除重复项并增加字幕预览实时同步。
- 后端数据库：`backend/app/db/crud.py` 与测试，统一把 dataclass/Pydantic/第三方对象转换为 JSON-safe 值。
- 文档：桌面归档、总结隐私、模型管理、后端 API、CHANGELOG 和专项验证报告。

## 实现步骤

1. 添加失败回归：流式 PCM 录音导出、归档路径规划、总结来源与卡片迁移、自动保存、软件内回填、复制 IPC 非阻塞、字幕预览同步、Qwen 第三方对象序列化。
2. 为 `PcmStreamer` 增加连续 PCM 收集和 WAV 导出，`StreamingASRClient.stop()` 返回本次本机录音；实时识别结束后把音频和 JSON 一次归档。
3. Electron 归档根据明确 `category` 创建 `wav/<类别>/<日期>` 和 `json/<类别>/<日期>`，离线和实时使用稳定中文目录名。
4. store v37 增加 `summaryPromptCards`、`activeSummaryPromptCardId`、`summaryWorkspace.source` 和被动总结来源；迁移现有单值 `summaryPrompt`。
5. 主动总结成功后自动写本机总结日志；被动总结无论来源均自动保存，UI 保留另存为但不再依赖手动“保存到日志”。
6. 识别成功后先更新软件 store，再并行归档/外部输入；实时结果结束后同样设置 `currentResult`。overlay 复制只负责快速复制和隐藏，主窗口通知延后到下一事件循环。
7. 模型管理只保留 LLM 连接字段；自动执行开关仍由语音识别页控制。
8. 设置页跟踪预览打开状态，字幕属性变化时调用同一预览 API 更新窗口。
9. 数据库持久化使用严格 JSON-safe 转换；Qwen adapter 也只保留第三方结果的可序列化快照，避免在日志/归档的其他入口重复失败。
10. 运行目标和全量 Vitest、renderer/Electron TypeScript、Vite、后端目标测试/compileall、VitePress、截图与 `git diff --check`。

## 风险评估

- **内存占用**：实时音频收集为 16 kHz mono PCM，约 1.9 MiB/分钟；停止或异常关闭后必须释放数组，避免跨会话累计。
- **双重关闭**：WebSocket `close` 与用户 `stop` 可能同时触发，音频导出和归档必须幂等，避免生成两个文件。
- **目录兼容**：已有浅层文件不自动移动或删除；新归档只使用新层级。
- **总结来源**：选择服务端时不得偷偷混入本机记录；选择本机时必须显式传 `records`，包括空数组。
- **复制性能**：不能把耗时的窗口激活、UIAutomation 或主窗口状态更新串入复制按钮同步路径。
- **Qwen 原始对象**：第三方对象结构可能变化；转换器必须支持 Pydantic、dataclass、映射、序列、`to_dict` 和未知对象的安全字符串兜底。
- **验证边界**：Linux 可验证 PCM/WAV 结构、IPC 状态机和 Electron 截图；真实 Windows 剪贴板/字幕窗口动态尺寸仍需脚本化 Electron E2E，不能仅凭单元测试声称硬件实机通过。

## 实施结果

- 实时录音直接复用 WebSocket 已发送的 PCM 帧生成 WAV，避免另开音频输入造成内容不一致。
- 本机归档统一由 Electron 路径模块创建并写入，路径与实际文件内容均有临时目录回归测试。
- 软件内结果状态先于外部 UIAutomation 投递更新；弹窗复制在 overlay renderer 的下一事件循环执行，主进程只负责隐藏和通知。
- Qwen adapter 和数据库持久化入口均执行 JSON-safe 转换，防止第三方对象从其他调用路径再次进入 `json.dumps`。
- 当前环境的 Electron 页面截图命令因审批额度拒绝而未执行成功；UI 当前态以 React DOM/IPC 测试和 TypeScript/Vite 构建验证，未把旧截图或单元测试标记为当前截图证据。
