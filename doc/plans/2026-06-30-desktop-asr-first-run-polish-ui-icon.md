# 桌面语音识别首连、润色、布局和图标修复

## 任务目标

1. 桌面前端首次安装/首次运行时不主动连接任何后端地址，只有用户输入并确认后端 IP/地址后才发起后端请求。
2. 仅为离线语音输入 ASR 结果增加大模型润色开关和用户可预设 Prompt，复用模型管理中的 LLM 设置，后端不保存 token。
3. 删除语音识别页的“网络良好”和右侧时间显示，将“开始录音”“实时识别”控制移动到页面最上方。
4. 将文件识别区域移动到语音识别页最下方。
5. 将桌面窗口/任务栏/托盘图标统一指向 `img/Amadeus/amadeus.jpg`，修复默认图标残留。
6. 截图并结合 Image Gen skill 做 UI 问题识别，修复不同窗口比例下的重叠和比例异常。
7. 实时识别开启时同步显示桌面字幕框；点击字幕框叉号结束实时识别；停止实时识别后不重置“实时识别显示桌面字幕框”设置。

## 影响范围分析

- `frontend/desktop/src/store/useASRStore.ts`：新增首次后端确认、离线 ASR 润色开关和 Prompt 持久化字段；迁移旧默认后端地址。
- `frontend/desktop/src/services/api.ts`、`recordingService.ts`：避免未确认后端时自动请求；离线录音上传时带润色配置且 token 仅随请求发送。
- `frontend/desktop/src/pages/Transcribe.tsx`：调整识别控制、文件识别位置、状态显示和润色设置。
- `frontend/desktop/src/App.tsx`、`electron/main.ts`、`electron-builder.yml`：首连确认入口、字幕关闭行为和图标配置。
- `frontend/desktop/src/styles/global.css`：修复语音识别页响应式布局重叠。
- `backend/app/api/v1/transcribe.py` 及相关测试：确认/补充 token 不落库行为。
- `doc/CHANGELOG.md`、桌面文档：记录本次行为变更。

## 实现步骤

1. 阅读相关 store、API、语音识别页、字幕 overlay 和 Electron 图标实现。
2. 新增/调整测试，覆盖未确认后端不请求、离线 ASR 润色请求、token 不保存、字幕关闭停止实时识别和 UI 文案移除。
3. 实现首次后端确认门禁和语音识别页离线润色设置。
4. 调整语音识别页布局，移除“网络良好”和时间，移动控制区与文件识别区。
5. 强化 Electron 图标加载与打包图标配置。
6. 启动前端，截图桌面/窄屏比例，调用 Image Gen skill 识别视觉问题，再按实际问题修复 CSS。
7. 运行 TypeScript、Vite build、相关 Vitest/Pytest/compileall 和 diff 检查。
8. 更新 CHANGELOG 和项目文档。

## 执行偏差

- 计划中的 Electron 截图在受限沙箱内无法完成：首次尝试因 `ELECTRON_RUN_AS_NODE=1` 被当作 Node 运行，修正后又被 Linux Electron sandbox 拦截；一次提升权限尝试仅生成了旧脚本的错误页面截图，后续提升权限重拍被策略拒绝。最终未将该截图作为验收证据，改为保留本地截图脚本、使用 Image Gen 审查项指导 CSS 修复，并以 TypeScript/Vite/针对性测试验证代码路径。

## 风险评估

- 首次后端确认会影响现有默认 `http://localhost:8000` 流程，需要确保已确认用户和开发环境仍可正常使用。
- LLM 润色依赖用户已有模型设置和 token；前端可发送 token，但后端必须继续只保存脱敏配置与结果。
- 字幕框关闭语义从“隐藏”变为“结束实时识别”只应作用于实时识别会话，不能误关设置页预览。
- Electron 任务栏图标在不同平台对 JPEG/ICO/PNG 支持不一致，需要同时保留运行时 nativeImage 与打包配置路径。
- 响应式修复需要通过截图确认，避免只修一个窗口尺寸。
