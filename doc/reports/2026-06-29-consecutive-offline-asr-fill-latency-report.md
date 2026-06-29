# 连续离线 ASR 自动回填延迟测试报告

> **父文档**: [← 返回桌面端](../desktop/README.md)
> **相关计划**: [连续离线 ASR 自动回填延迟修复](../plans/2026-06-29-fix-consecutive-offline-asr-fill-latency.md)

## 结论

后端和 Zustand 结果状态不是数秒延迟的根因。Renderer 在收到最终 ASR 文本后已经立即调用 `injectText`。Windows 真机 E2E 最终确认主因是 Electron 主线程在入队前同步调用 `clipboard.writeText`，而 STA helper 也会写剪贴板；剪贴板被占用时，主线程可阻塞约 9 秒，队列、超时定时器和第二次回填都无法调度。串行队列积压、helper 未 ready 就启动单次计时，以及旧 helper 退出事件可能清理新 pending 请求会进一步放大问题。

修复后删除 Electron 主线程的重复剪贴板写入，只由 STA helper 写入；helper 在应用启动时预热，单次 475 ms 注入预算从 ready 后开始。调度采用 latest-wins，新结果会取消仍卡住的旧注入，尚未开始的中间请求不会继续占队；每个 pending 请求绑定创建它的 helper，旧进程事件不能再修改新请求状态。普通请求仍串行，避免同时操作剪贴板和输入焦点。

## 先失败、后修复

```text
修改前连续双次复现：第二次发送 → 回填 1190.2 ms，FAIL（门槛 500 ms）
修改后同一阻塞场景：约 13 ms，PASS
30 轮离线识别即时响应：p95 0.0 ms，max 0.1 ms，PASS
30 轮正常注入队列：全部 < 500 ms，PASS
Windows 修复前第二次真实注入：约 9991.6 ms，FAIL
Windows 修复后真实 textarea：第一轮 441.9 ms，第二轮 130.2 ms，PASS
```

## 回归验证

```text
连续识别专项：5 passed
桌面前端全量：44 passed
Renderer TypeScript：passed
Electron TypeScript：passed
Vite production build：passed
git diff --check：passed
Windows unpacked 隔离 E2E：全部 passed
```

专项入口：

```bash
bash scripts/test_consecutive_offline_asr_fill.sh
```

## 环境边界

Linux/WSL 自动化覆盖即时后端响应、Renderer 状态更新、卡死注入取消、旧 helper 隔离和 30 轮压力门槛。Windows 隔离 E2E 已实际通过连续真实 textarea 注入检查；可复跑：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/run_amadeus_windows_e2e.ps1
```

本次结果位于 Windows 临时隔离目录的 `userData/e2e/result.json`；检查要求第二轮实际写入 textarea 且耗时低于 500 ms。
