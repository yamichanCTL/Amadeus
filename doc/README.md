# Amadeus 文档索引

> **父文档**: 当前为顶层文档
> **子文档**:
> - [桌面端](desktop/README.md)
> - [开发环境](development/README.md)
> - [Amadeus 完整文档树](asrapp/README.md)
> - [环境安装与迁移](asrapp/installation/README.md)
> - [变更日志](CHANGELOG.md)

## 模块

- [Amadeus 完整文档树](asrapp/README.md)：从 `~/AI/doc` 合并迁入的 VitePress 文档树，包含架构、后端、Runner、前端、ASR 与设计决策。
- [环境安装与迁移](asrapp/installation/README.md)：后端、桌面端、Android、第三方库/模型和迁移验收。
- [桌面端](desktop/README.md)：Electron 桌面客户端、实时语音、TTS 与变声器功能。
- [开发环境](development/README.md)：工作区级编辑器设置与开发工具约定。

## 文档站

- [VitePress 首页](index.md)：项目文档站入口。
- `.vitepress/config.mts`：文档站导航、侧边栏、搜索与页面配置。
- `package.json` / `package-lock.json`：文档站依赖与脚本。

## 归档

- 旧版散落文档、外层总仓迁入归档、文档站生成产物、根目录样例音频和 Python 构建产物已整理到项目本地 `tmp/`。
- `tmp/` 为 gitignored 本地目录，不参与文档站构建和版本提交。
