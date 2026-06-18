# VS Code 工作区文件打开行为

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **子文档**: 无

## 任务目标

将当前工作区的 VS Code 文件打开行为设置为：

- 单击资源管理器文件时，以 preview 临时标签打开。
- 再单击其他文件时，复用同一个 preview 标签。
- 双击文件或编辑 preview 标签后，固定为常规标签页。

## 影响范围分析

- `.vscode/settings.json`：新增工作区级 VS Code 设置。
- `doc/development/README.md`：记录开发环境约定。
- `doc/README.md`、`doc/.vitepress/config.mts`：补充文档入口。
- `doc/CHANGELOG.md`：记录本次变更。

## 实现步骤

1. 新增 `.vscode/settings.json`。
2. 启用 `workbench.editor.enablePreview`，保持 preview 标签行为。
3. 启用 `workbench.editor.enablePreviewFromQuickOpen`，让快速打开也遵循 preview 行为。
4. 设置 `workbench.list.openMode` 为 `singleClick`，让资源管理器单击打开 preview。
5. 更新开发环境文档、文档索引和 CHANGELOG。

## 风险评估

- 这是工作区级配置，只影响打开当前 asrapp 工作区的 VS Code 窗口。
- 如果用户全局设置关闭了 preview，工作区设置会覆盖全局设置。
- 如果以后希望单击只选中文件、不打开 preview，需要把 `workbench.list.openMode` 改为 `doubleClick`。
