# 恢复异常回退的 Amadeus 桌面文件

> **相关计划**: [Amadeus 录音、浮窗、输入注入与音频路由改造](2026-06-21-amadeus-capture-overlay-routing-userid.md)
> **验证基线**: [Amadeus 桌面输入、浮窗与音频路由测试报告](../reports/2026-06-21-amadeus-desktop-capture-overlay-routing-test-report.md)

## 目标

对照 2026-06-21 的实际补丁记录，恢复被异常回退的桌面实现，同时保留当前工作树中仍然存在的 Amadeus 改动和用户文件。

## 已确认的回退范围

- `frontend/desktop/electron/main.ts`：应用名、响应式窗口下限、动态状态浮窗、字幕控制、用户 ID、Windows 文本注入和隔离 E2E 接入丢失。
- `frontend/desktop/src/pages/Transcribe.tsx`：预热录音器、请求取消/强制停止、真实电平、用户 ID、实时 partial 补建和精简预览丢失。
- `frontend/desktop/src/pages/Settings.tsx`：用户 ID、持久音频中转、输出设备和字幕框尺寸控制丢失。
- `frontend/desktop/src/styles/global.css`：固定页面最小宽度重新出现，响应式断点和恢复功能相关样式丢失。
- `frontend/desktop/src/store/useASRStore.ts`：Agent 品牌、字段归一化和持久化版本回退。
- `frontend/desktop/electron-builder.yml`：安装包产品名回退为 `ASR Desktop`。

## 执行与验证

1. 从上轮本地会话记录按原补丁顺序恢复上述文件，不覆盖未回退文件。
2. 运行 renderer/Electron TypeScript、Vite 构建、后端定向 pytest、Python compileall 和文档构建。
3. 运行 `git diff --check`，核对关键实现标记和工作树范围。
4. 在 `doc/CHANGELOG.md` 记录本次恢复及验证结果。

## 验证结果

- renderer TypeScript：通过。
- Electron 主进程 TypeScript：通过。
- Vite 生产构建：通过，转换 75 个模块。
- 后端 Amadeus/流式定向测试：`6 passed in 0.23s`。
- Python compileall：通过。
- VitePress 文档构建：通过。
- `git diff --check`：通过。

## 风险

- 工作树存在用户的未跟踪 `thirdparty/`，本次不读取、不修改该目录。
- Windows 前台注入和物理音频回环仍属于实机验收；本次恢复以原补丁和可重复构建测试为准。
