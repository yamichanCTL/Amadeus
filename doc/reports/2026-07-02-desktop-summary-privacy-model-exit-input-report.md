# 2026-07-02 桌面总结、隐私、模型、退出与输入验证报告

> **父文档**: [← 返回桌面端总览](../desktop/README.md)
> **实施计划**: [查看 Plan](../plans/2026-07-02-desktop-asr-summary-privacy-model-exit-input.md)

## 需求验证

| # | 需求 | 结果 | 证据 |
|---|---|---|---|
| 1 | 后端记录 AI 润色结果 | 通过 | 同步/异步 ASR 共用日志函数；caplog 验证任务 ID和润色文本 |
| 2 | 总结类型选择离线/实时 | 通过 | 固定下拉映射 `一段语音转写` / `实时转录` |
| 3 | 默认 `00:00` 到当前时间 | 通过 | 本地时间纯函数测试覆盖 `14:07` 分钟格式；主动/被动默认值均落地 |
| 4 | 当日总结 Prompt | 通过 | Prompt 持久化并随主动、被动请求发送 |
| 5 | 未授权不保存服务端调试数据 | 通过 | HTTP 成功/失败、Celery 成功/失败均有 opt-in 门控；流式默认 false 且客户端显式发送 false |
| 6 | 前端发现后端新增模型 | 通过 | 模型行、离线/实时选择和新配置回退均来自 `/v1/models`；`future-asr` / hybrid 测试通过 |
| 7 | 未选择后台运行时真正退出 | 通过（逻辑） | 默认 `quit`、显式开启才 `hide` 的 Electron 决策测试通过 |
| 8 | 重启后自动填充可靠性 | 通过（模拟） | helper `ready` 握手设 1.5 秒上限，异常时清理并重启一次；取消的旧请求不重试；注入前先保留剪贴板 |

## 自动化结果

- Desktop Vitest：`19 files / 71 tests` 全部通过。
- 新增关键回归集合：`6 files / 14 tests` 全部通过。
- Backend：隐私/润色日志与 streaming session 定向测试 `6 passed`。
- Renderer TypeScript：通过。
- Electron TypeScript：通过。
- Vite 生产构建：通过，`78 modules transformed`。
- Python `compileall backend/app`：通过。

## 环境边界

当前 Linux/WSL 执行环境不能替代 Windows 真机验证以下两项：

- 点击打包后 Windows 标题栏关闭按钮后，任务管理器中进程实际消失；
- Windows 重启后，在 VS Code、浏览器、QQ/微信等真实目标输入框中执行 UIAutomation + Ctrl+V。

本轮已验证这两条路径的状态机、IPC、重试、剪贴板兜底、TypeScript 和生产构建；最终真机验收应运行 `scripts/run_amadeus_windows_e2e.ps1`。

---

> 📖 [返回桌面端总览 →](../desktop/README.md)
