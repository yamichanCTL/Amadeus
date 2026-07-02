# 优化状态浮窗、自动输入与后端可迁移运行时

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **相关文档**: [桌面输入与覆盖层](../desktop/INPUT_AND_OVERLAYS.md)

## 任务目标

1. 将收音与识别状态浮窗缩小到 200×32，并把波形改为横向时间历史，让用户看到一小段时间内的声音变化。
2. 修复 Windows 可编辑焦点被误判后显示结果框的问题；光标位于可编辑文本控件时直接自动粘贴并关闭 Thinking 浮窗。
3. 确认桌面前端与后端 ASR 默认超时均为 20 秒。
4. 清除后端应用代码中的机器绝对路径，将模型、数据和外部源码路径统一通过 backend `.env` 配置，并保留可迁移的相对路径解析。
5. 诊断并修复 X-ASR CUDA 运行时的 `CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH`，恢复实时识别模型。

## 影响范围

- `frontend/desktop/electron/main.ts`：状态浮窗尺寸、波形样式、Windows UI Automation 焦点检测。
- `frontend/desktop/electron/e2e.ts`：状态浮窗尺寸与自动注入验收。
- `backend/app/config.py`、`backend/.env.example`、后端部署文档：路径配置集中化与相对路径规则。
- `backend/app/core/asr/engines/x_asr.py`、X-ASR 安装/验证脚本：CUDA/cuDNN 动态库选择与启动验证。
- `doc/desktop/INPUT_AND_OVERLAYS.md`：浮窗和自动输入行为说明。
- `doc/CHANGELOG.md`：本轮变更记录。

## 实现步骤

1. 将普通 recording/thinking/error 浮窗的宽高、padding、圆角和字体收紧到 200×32。
2. 使用 28 个窄柱维护滚动电平队列，每次 peak/RMS 更新时左移历史并在右侧追加新值；Thinking 状态复用同一波形区域播放动画。
3. 用直接的 PowerShell UI Automation 调用替代临时 C# 焦点检测类型，优先读取 `ValuePattern.IsReadOnly`，兼容 `ControlType.Edit`，并对 QQ/TIM/微信、VS Code/Cursor/Trae 的自绘编辑控件增加受限进程 fallback。
4. 保持自动粘贴成功后只关闭状态浮窗；仅在不可编辑或注入失败时展示带复制/关闭按钮的结果框。
5. 执行 Renderer/Electron TypeScript、Vite 构建、E2E 静态断言、后端默认值断言与文档构建。
6. 扫描后端应用代码中的绝对路径，将机器相关值迁入 `.env`，补充环境变量模板与部署说明。
7. 核对 sherpa-onnx、ONNX Runtime、cuDNN 主库/子库版本和加载顺序；修复库根目录选择后运行真实 X-ASR CUDA 验证。

## 风险评估

- Windows UI Automation 与真实跨应用输入无法在当前 Linux/WSL 环境执行，需由 Windows E2E 完成最终验证。
- 自绘编辑器按焦点元素所属进程兼容；如果目标应用未在兼容清单或 Windows 完整性级别更高，仍会进入结果框，避免向任意控件误发 Ctrl+V。
- 用户已持久化的超时值不会被强制覆盖；20 秒只作为新设置及后端请求缺省值。
- `.env` 中的相对路径必须按统一基准解析，否则不同启动 cwd 会再次产生漂移。
- cuDNN mismatch 修复必须证明同一组主库和子库被加载；若当前虚拟环境二进制包本身不兼容，需要调整本地依赖，但不应在代码中写入机器路径。

## 计划偏离说明

初版 Plan 只记录了浮窗、自动输入与超时复核。完成前端小改后，已在开始后端代码修改前扩展本 Plan，纳入用户同一请求中的路径迁移和 X-ASR CUDA 故障修复。

## 执行与验证结果

- 普通状态浮窗已改为 200×32；28 段窄柱按采样顺序维护时间历史，Electron E2E 尺寸和末端波形高度断言同步更新。
- UI Automation 先检查 `ValuePattern` / `ControlType.Edit`，再对 QQ/TIM/微信、VS Code/Cursor/Trae 的自绘控件按焦点进程放行；自动粘贴成功仍直接关闭 Thinking 浮窗。
- 后端应用目录中已无用户家目录、`/root`、`/usr/local/cuda` 或固定系统 libstdc++ 路径；新增 `backend/.env.example`，当前机器路径只保留在被忽略的 `backend/.env`。
- X-ASR CUDA 默认运行在独立 spawn worker。真实 6.8 秒录音使用 960 ms 模型完成 213 个 PCM 块、6 次 partial 和 1 次 final，runtime 为 `sherpa-onnx 1.13.2+cuda12.cudnn9`；当前运行中的 8000 后端也成功通过模型加载 API 启动 worker，并返回非空 `worker_pid`。
- `backend/tests/test_x_asr.py` 13 项通过，X-ASR 文件 Ruff 检查通过；Renderer TypeScript、Electron TypeScript、Vite 生产构建（77 modules）和 VitePress 文档构建通过。
- 后端配置和请求 schema 默认值均断言为 20 秒；桌面语音识别、Agent 语音和参考音频识别均携带 `settings.timeoutSec`。
- Windows UI Automation 与 SendInput 不能在当前 Linux 环境直接执行，QQ/VS Code 的真实粘贴仍需运行 Windows E2E。后端 `test_api.py::test_liveness` 的 ASGI fixture 在 20 秒内未返回，但当前真实 `/v1/health` 正常响应；该测试挂起不影响本轮 X-ASR 单元与实机验证结论。
