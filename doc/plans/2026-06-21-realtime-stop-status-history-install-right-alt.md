# 实时识别停止、状态反馈、历史筛选与环境迁移

> **父文档**: [← 返回计划索引](README.md)

## 任务目标

1. 修复实时识别无法可靠停止的问题，停止操作必须立即恢复到可再次启动的状态。
2. 补齐流式 ASR/TTS 的连接、加载、就绪、配置完成、关闭等前后端状态反馈。
3. 历史记录支持按起止日期（含边界日）筛选，并将所有记录时间显示到秒。
4. 提供前端、后端、Android、第三方依赖与模型的分层环境安装和迁移指南。
5. 新安装默认使用键盘右 Alt 触发语音识别，并兼容已有持久化配置。

## 影响范围

- 桌面实时链路：`frontend/desktop/src/services/audio.ts`、实时识别/Agent/变声页面及状态组件。
- Electron 触发器：`frontend/desktop/electron/main.ts`、preload 类型、快捷键服务和设置页。
- 历史页：`frontend/desktop/src/pages/History.tsx`、`frontend/desktop/src/styles/global.css`。
- 状态与迁移：`frontend/desktop/src/store/useASRStore.ts`。
- 文档：`doc/asrapp/installation/`、相关模块索引、VitePress 导航、`doc/CHANGELOG.md`。

## 实现步骤

1. 梳理 WebSocket 停止和关闭事件，加入幂等关闭通知并让前端主动停止立即完成 UI 收尾。
2. 将后端已有的 `accepted/loading/ready/configured` 消息暴露给页面，统一连接阶段文案。
3. 修复实时页和变声页对异常状态下活动连接的判断，避免按钮状态与实际连接脱节。
4. 为历史页加入文本、语言、起止日期组合筛选及秒级本地时间格式化。
5. 使用 Electron 输入事件监听区分 `AltRight`，保留普通组合快捷键注册，并迁移旧默认值。
6. 从实际依赖清单、脚本和模型注册表整理分层安装文档。
7. 执行 TypeScript 构建、后端相关测试、文档构建和静态检查，记录验证结果。

## 风险评估

- Electron `globalShortcut` 不能区分左右 Alt，需要用主进程输入事件检测 `AltRight`；其触发范围受 Electron 收到的系统输入事件能力影响，必须通过桌面实机验证。
- 主动停止时立即关闭 WebSocket 可能丢弃最后一个尚未返回的 partial/final；显式停止以确定性优先，已收到文本仍会保存。
- 旧用户的触发方式属于用户设置，不能覆盖；仅迁移仍等于旧默认中键的持久化值。
- 仓库存在大量进行中修改，本任务只做小范围补丁，不整理或覆盖无关改动。

## 执行结果

- 桌面端 `npm run build` 通过，生成 Linux AppImage。
- 文档站 `npm run build` 通过；`git diff --check` 通过。
- `test_streaming_session.py` 与 `test_model_errors.py` 共 6 项通过。
- Android `:app:assembleDebug` 因执行权限审查额度被拒绝，命令未启动；这不是 Gradle 或源码失败。当前任务未修改 Android 业务代码，仍需在具有 Android SDK/Gradle 缓存访问权限的环境执行指南中的验收命令。
