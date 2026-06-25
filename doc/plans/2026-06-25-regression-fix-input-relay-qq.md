# 回归修复输入与录音链路

> **父文档**: [← 返回计划索引](README.md)
> **子文档**: 无

## 任务目标

- 修复上一轮改动后可能出现的麦克风二次打开、录音启动变慢和 QQ 仍无法输入问题。
- 保持 ASR 最终文本立即投递，不把归档/历史记录挡在输入前。
- relay 启用时只克隆 relay 内部的麦克风输入轨道，不使用输出混音总线。

## 实现步骤

1. 录音开始时窗口捕获改为非阻塞触发，避免 PowerShell 捕获卡住录音状态切换。
2. 离线 ASR 与 TTS 录音在 relay 激活时复用 `createInputStream()` 的麦克风 clone，避免再次打开设备；显式扬声器模式仍只走 loopback。
3. Windows 注入 helper 接收捕获到的目标进程名；QQ/TIM/微信这类目标即使 UIA 当前焦点不标准，也直接按兼容粘贴路径尝试输入。
4. 跑 TypeScript、Vite build 和 diff check 验证。

## 风险评估

- 当前环境无法直接验证 Windows QQ 输入框和真实声卡设备；需要保留失败时结果浮窗和剪贴板 fallback。

## 验证记录

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit`：通过。
- `node node_modules/vite/bin/vite.js build`：通过。
- `git diff --check`：通过。
