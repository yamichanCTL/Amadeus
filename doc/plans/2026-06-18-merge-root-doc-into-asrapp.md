# 合并外层 doc 到 asrapp 项目文档

> **父文档**: [← 返回文档索引](../README.md)
> **子文档**: 无

## 任务目标

将 `~/AI/doc` 迁入 `~/AI/asrapp/doc`，并判断迁入策略是合并还是替换。

结论：采用合并，不采用替换。原因是 `~/AI/asrapp/doc` 已包含近期桌面端 TTS、变声器、模型设置等文档和 plan，直接替换会丢失当前项目内已有资料；外层 `~/AI/doc` 则包含 VitePress 配置、历史 asrapp 文档树和旧计划，适合作为补充迁入。

## 影响范围分析

- `doc/`：迁入外层文档站配置、文档树、历史计划和包配置。
- `doc/README.md`：保留 asrapp 现有文档索引，并补充迁入后的 VitePress 与历史文档入口。
- `doc/CHANGELOG.md`：追加本次迁入记录，保留已有 changelog。
- `~/AI/doc`：迁入完成后移除源文档目录中的项目文档源文件；生成依赖不作为项目文档内容保留。

## 实现步骤

1. 对比 `~/AI/doc` 与 `~/AI/asrapp/doc` 的文件结构和同名文件。
2. 创建本 plan，明确采用合并策略。
3. 将外层文档中的非冲突文件和目录迁入 `asrapp/doc`。
4. 对冲突入口文件手动合并：保留 `asrapp/doc/README.md` 与 `asrapp/doc/CHANGELOG.md` 的当前内容，并追加迁入说明和历史入口。
5. 清理源 `~/AI/doc` 中已迁入的文档源，避免两套文档并存。
6. 验证迁入后文件结构，并更新 CHANGELOG 与项目文档索引。

## 风险评估

- 风险：替换会丢失当前 asrapp 文档。处理：采用合并。
- 风险：同名 `README.md`、`CHANGELOG.md` 内容来源不同。处理：手动合并，不覆盖目标文件。
- 风险：`node_modules`、`.vitepress/cache` 属于生成物，迁入会污染项目。处理：只迁移文档源和 lockfile，不把生成缓存作为文档内容依赖。
