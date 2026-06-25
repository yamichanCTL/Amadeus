# 锁定输入目标、纯麦克风录音与立即注入

> **父文档**: [← 返回计划索引](README.md)
> **子文档**: 无

## 任务目标

- 离线 ASR 一收到最终文本就立即触发自动输入，不再被 telemetry、store 更新、历史记录或归档挡住。
- 录音开始前记住用户当前输入目标，状态浮窗弹出后仍能回到 QQ/聊天框等原目标执行粘贴。
- 离线 ASR 与 TTS 录音默认只打开所选麦克风，不复用音频中转 relay 输入，避免混入输出/虚拟声卡链路。

## 影响范围

- `frontend/desktop/electron/main.ts`：Windows 前台窗口捕获与注入前恢复。
- `frontend/desktop/electron/preload.ts`、`frontend/desktop/src/vite-env.d.ts`：暴露目标窗口捕获 IPC。
- `frontend/desktop/src/services/recordingService.ts`：录音开始前锁定目标、结果返回后优先投递。
- `frontend/desktop/src/pages/VoiceChanger.tsx`：TTS 录音使用独立麦克风通路。
- `doc/desktop/*`、`doc/CHANGELOG.md`：同步行为说明与验证记录。

## 实现步骤

1. 新增 `text:captureTarget`：录音浮窗显示前捕获前台窗口句柄，注入 helper 收到文本时先恢复该窗口。
2. 重排离线 ASR 完成路径：拿到 `result.full_text` 后立即启动 inject/copy promise，再做状态、历史、归档和 telemetry。
3. 将离线 ASR / TTS 录音从 `audioRelayMixer.createInputStream()` 改为直接使用所选输入设备；仅显式扬声器模式使用 loopback。
4. 跑 renderer/node TypeScript、Vite build 与 `git diff --check`。

## 风险评估

- QQ/微信等外部应用仍需 Windows 本机验证；当前环境只能验证类型与构建。
- 如果某个麦克风驱动不允许同一设备被 relay 和离线录音同时打开，会返回明确的启动错误，不再静默走混合链路。

## 验证记录

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit`：通过。
- `node node_modules/vite/bin/vite.js build`：通过。
- `git diff --check`：通过。
