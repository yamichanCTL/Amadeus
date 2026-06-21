# 桌面前端环境

> **父文档**: [← 返回环境安装总览](README.md)
> **子文档**: [后端环境](BACKEND.md) · [迁移检查表](MIGRATION.md)

## 版本与安装

桌面端使用 Electron 31、React 18、Vite 5、TypeScript 5 和 Node 类型 20。推荐 Node.js 20 LTS 与仓库中的 `package-lock.json`：

```bash
cd /path/to/asrapp/frontend/desktop
npm ci
npm run dev
```

完整构建：

```bash
npm run build
# 在 Windows 主机上构建 Windows 包
npm run build:win
# Linux AppImage
npm run build:linux
```

开发期 Vite 将 HTTP/WebSocket 请求代理到后端；打包后在“设置”中填写后端地址，例如 `http://127.0.0.1:8000`。

## 平台能力

- Windows：托盘、全局鼠标触发、全局右 Alt、扬声器 loopback、文本自动粘贴。
- Linux/macOS：普通 Electron accelerator 可全局注册；单独右 Alt 因 Electron accelerator 不区分左右修饰键，仅在应用收到该键盘事件时触发。
- 浏览器预览：没有 preload 提供的托盘、全局触发、归档文件写入等桌面能力。

## 本地状态

Zustand 设置和最近 200 条历史保存在 Electron/浏览器 localStorage；Electron 归档目录默认为应用 `userData/archive`。迁移时先在设置页记录后端地址、输入/输出设备和模型选择。音频设备 ID 与机器绑定，不应原样迁移。

构建验收以 `npm run build` 成功为准；麦克风、扬声器和全局按键仍需在目标桌面系统实测。

