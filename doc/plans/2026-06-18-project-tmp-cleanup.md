# 项目非核心文件整理到 tmp

## 任务目标

将项目根目录和文档目录中明显非核心、可再生成或仅作历史参考的文件整理到项目内 `tmp/`，并通过 `.gitignore` 忽略 `tmp/`，减少工作树噪音。

## 影响范围分析

- 新增 `tmp/` 作为本地归档和临时产物目录。
- 更新 `.gitignore`，忽略 `tmp/` 以及常见本地缓存目录。
- 更新 `doc/README.md` 和 VitePress 配置，移除已归档旧文档的站点导航入口。
- 更新引用旧散落文档的模块文档，改为指向当前维护文档。
- 将被 `CHANGELOG` 引用的历史 plan 从 `doc/` 根部移入 `doc/plans/`，保留工作流审计记录。
- 保留核心源码、测试、运行配置、当前文档树和启动脚本。

## 实现步骤

1. 识别非核心候选：
   - 根目录样例音频：`录音.m4a`、`录音.wav`、`录音_22k.wav`
   - 构建/缓存产物：`build/`、`asr_backend.egg-info/`、`.pytest_cache/`、`.ruff_cache/`、`.uv-cache/`
   - 文档站生成产物和依赖：`doc/node_modules/`、`doc/.vitepress/dist/`、`doc/.vitepress/.temp/`、`doc/.vitepress/cache/`
   - 旧版散落文档：`doc/backend.md`、`doc/desktop.md`、`doc/streaming.md`、`doc/instruction.md`、`doc/archive/root-doc/`
2. 将候选移动到 `tmp/` 下按类型分组保存。
3. 将 `doc/task-plan-20260618-224101-tts-voice-library.md` 移入 `doc/plans/`，并修正 `CHANGELOG` 链接。
4. 更新 `.gitignore` 增加 `tmp/` 和 `.uv-cache/`，并保留既有缓存忽略规则。
5. 更新文档索引和 VitePress 侧边栏，避免引用已忽略归档内容。
6. 检查 git 状态，记录 CHANGELOG。

## 风险评估

- 旧版文档移入 `tmp/` 后不会进入文档站构建；需要确保当前 `doc/asrapp/`、`doc/desktop/`、`doc/development/` 已覆盖主要信息。
- `doc/.vitepress/config.mts` 必须保留，不能移动整个 `.vitepress/`。
- 不移动 `.venv/`、`data/`、`models/` 和 `.runtime/`，避免破坏本地开发环境、运行数据和用户当前实验状态。
