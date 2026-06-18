# 开发环境

> **父文档**: [← 返回文档索引](../README.md)
> **子文档**: 无

## VS Code 文件打开行为

当前工作区通过 `.vscode/settings.json` 固定 VS Code 的文件打开行为：

- `workbench.editor.enablePreview: true`：启用 preview 临时标签。
- `workbench.editor.enablePreviewFromQuickOpen: true`：快速打开文件时也先进入 preview 标签。
- `workbench.list.openMode: singleClick`：在资源管理器单击文件时打开 preview。

效果是单击文件只会临时打开；继续单击其他文件会复用这个临时标签；双击文件后才会固定为常规标签页。
