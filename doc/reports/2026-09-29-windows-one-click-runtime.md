# Windows 一键环境与桌面启动验收

日期：2026-09-29。

## 交付

- Windows NSIS 安装包：`frontend/desktop/release-windows-setup/Amadeus-Windows-Setup-0.1.0.exe`。
- 打包的桌面程序：同目录 `win-unpacked/Amadeus.exe`。
- 设置 → 常规新增“在这台电脑上运行”，提供一键安装并启动、仅安装、启停、自动启动、修复与日志。
- 后端源代码、依赖锁文件和验证过的 uv 安装器随桌面程序分发。前端无需用户安装 Node.js；Python 在应用自己的数据目录下载和管理。
- 现有实时语音、3D 数字人口型功能保留。

## 实测证据

1. 从全新 `.runtime/Windows 新用户 验证` 用户目录启动打包后的 Electron，直接操作 UI“只安装环境”。独立 Python 3.12.12 与 76 个基础依赖成功安装；本次耗时约 23 秒，不能作为其他网络环境的保证。安装后服务尚未启动。
2. 点击“启动本机服务”，后端健康检查通过、前端自动连接；目录中的中文和空格未影响运行。
3. 六个实时模型配置入口正常；干净环境的已配置凭据数为 0，未发送任何付费 API 请求，也未采集麦克风。
4. 重复启动返回同一服务；点击停止后端口关闭，再次启动成功。
5. 实际播放本地 PCM 试听，检查 Three.js 实际口型权重，确认数字人口型运动。
6. 退出应用后自有后端停止；重开时自动启动并连接，已有项目后端 8000 始终健康。
7. 在测试环境停止服务并移走 `httpx/__init__.py`，点击“修复环境”；缺失模块恢复，`.env` 测试标记保留，服务重新启动正常。
8. 独立的第二套干净依赖测试也通过，启动约 2.97 秒，未安装 Torch。
9. TypeScript 两套编译、Vite 构建、NSIS 打包通过。8 个测试文件、59 项测试通过，覆盖管理器、设置 UI 和现有口型/语音回归。
10. 分发资源检查：无 `.env`、数据库、日志、`.pyc`。仅本机体验目录另外迁移了用户已有实时模型配置，未写入安装包。

原始记录在 `.runtime/windows-setup-qa/{report,restart-report,repair-report,quit-report}.json` 和 `.runtime/windows-dependency-smoke/report.json`，截图同目录。

自动化复验脚本：`scripts/windows/verify_desktop_setup.cjs`，只连接专门启动的 Amadeus 测试实例 9232，不连接 Chrome 或 Codex 内置浏览器。测试结束后已退出带调试端口的实例，供用户体验的实例不带调试端口。

## 范围

这是 Windows 基础环境在线安装包，首次安装仍需下载 Python 与依赖；没有在无网络的虚拟机中验证。已实测打包程序的安装 UI 和独立后端运行；NSIS 向导生成成功，未覆盖安装用户现有正式版本。

云端模型仍需用户自己的密钥与服务额度。本地 ASR 权重、CUDA、特定模型第三方组件、FFmpeg 不属于本次基础自动安装。完整步骤见 [Windows 快速开始](../desktop/windows-quick-start.md)。
