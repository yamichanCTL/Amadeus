# 修复扬声器输入与离线识别结果投递

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **相关文档**: [桌面输入与覆盖层](../desktop/INPUT_AND_OVERLAYS.md)

## 任务目标

1. 修复 Windows 桌面端选择“扬声器（系统音频输出）”后无法采集声音的问题，并覆盖快捷离线识别、实时字幕和设置页输入测试。
2. 离线识别完成后先检测当前焦点是否支持文本输入；可输入时在光标处粘贴，不可输入时复用状态覆盖层展示结果，并提供“复制”和“关闭”按钮。
3. 录音阶段只显示“语音输入中”，放大音量波形，不再显示“请检查输入设备”等判断性文案。
4. 将桌面端与后端识别任务的默认超时统一为 20 秒。

## 影响范围

- `frontend/desktop/electron/main.ts`：系统音频权限、可编辑焦点检测、状态覆盖层交互。
- `frontend/desktop/electron/status-overlay-preload.ts`：结果覆盖层安全 IPC。
- `frontend/desktop/src/services/audio.ts`：扬声器回环采集和输入测试。
- `frontend/desktop/src/services/liveCaption.ts`：实时识别复用系统音频流。
- `frontend/desktop/src/pages/Settings.tsx`、`Transcribe.tsx`、`RealtimeAgent.tsx`、`Models.tsx`：来源同步、离线识别结果投递及统一超时。
- `frontend/desktop/src/store/useASRStore.ts`：前端默认超时。
- `backend/app/config.py`、`backend/app/schemas/transcribe.py`、`backend/app/api/v1/transcribe.py`、`backend/app/tasks/asr_task.py`：后端默认超时与同步/异步请求执行限制。
- `frontend/desktop/electron/e2e.ts`、前后端测试：覆盖关键行为。
- `doc/desktop/INPUT_AND_OVERLAYS.md`、`doc/CHANGELOG.md`：使用和变更说明。

## 实现步骤

1. 在 Electron 主进程仅对主窗口放行 `display-capture`/`media`，并让 display-media handler 明确返回 Windows loopback 音频。
2. 将扬声器流创建封装为可复用函数；快捷录音、实时字幕、设置页测试统一使用该流，失败时不静默回退到错误的麦克风占位设备。
3. 同步“麦克风”设备下拉框和“音频输入来源”，避免两个设置互相冲突；扬声器模式禁用虚拟麦克风中转。
4. 在 Windows 文本注入前通过 UI Automation 检查焦点控件是否可编辑，仅在可编辑时写入剪贴板并发送粘贴键。
5. 无法输入时显示可交互结果覆盖层；复制按钮写入剪贴板并关闭，关闭按钮直接关闭。
6. 简化录音覆盖层文案并扩大波形；补充覆盖层 E2E 断言。
7. 将前端默认值和后端转写请求默认值设为 20 秒，并由前端将设置值随识别请求发送给后端。
8. 执行 TypeScript 构建、后端单元测试和文档构建。

## 风险评估

- Windows 系统音频回环依赖 Electron/Chromium 和系统输出设备，Linux 环境只能验证类型、权限分支和构建，真实扬声器声音仍需 Windows 端验证。
- UI Automation 对极少数未暴露可访问性信息的自绘控件可能判断为不可编辑；此时保守展示结果框，不会把文本误粘贴到非输入区域。
- 20 秒后端超时可能不足以完成首次模型加载；超时值仍允许用户在设置中调高或设为 0（不限制）。

## 执行与验证结果

- Renderer 与 Electron TypeScript 检查通过。
- Vite 桌面端生产构建通过（77 modules）。
- 后端 20 秒默认值、请求解析和超时守卫测试通过（2 passed）。
- Python 变更模块编译通过，`git diff --check` 通过。
- VitePress 文档构建通过。
- 当前 Linux/WSL 环境无法产生 Windows loopback 音频，也无法执行 UI Automation/SendInput；对应真实硬件与跨应用行为已加入 Windows E2E，需在 Windows unpacked 构建执行。
- 尝试运行完整 `backend/tests/test_api.py` 时，仓库现有同步转写 API 用例无输出挂起；本次改用不依赖该阻塞夹具的超时单元测试验证新增逻辑。
