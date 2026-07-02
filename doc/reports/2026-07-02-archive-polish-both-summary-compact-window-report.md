# 2026-07-02 润色归档、Both 总结与紧凑窗口验证报告

> **父文档**: [← 返回桌面端总览](../desktop/README.md)
> **实施计划**: [查看 Plan](../plans/2026-07-02-archive-polish-both-summary-compact-window.md)

## 需求结果

| # | 需求 | 结果 | 当前证据 |
|---|---|---|---|
| 1 | 归档 JSON 保存 AI 润色结果 | 通过 | 新归档写入 `llm_outputs.polish` 与 `labels.ai_polished`；同步/异步调用均传入脱敏输出 |
| 2 | 总结支持 Both / 所有类型 | 通过 | 主动和被动总结下拉新增空 category 选项；后端 Both 只收集离线/实时 ASR 类别 |
| 3 | 初始 UI 使用受限尺寸并居中 | 通过（算法/构建） | 后续上限调整为 1600×1000；2560×1440 工作区命中上限，1920×1040 得到 1498×853，均居中 |
| 4 | 总结只发时间与优先 AI label | 通过 | 每条输入只保留 `[开始-结束] label`；优先 AI 润色，实时无润色时回退 ASR label；不发送模型、用户、元数据或完整 JSON |

## 指定归档复核

用户指定文件：

```text
data/archive/dsmdesktop/2026-07-02/一段语音转写/2026-07-02_22-11-14_fireredasr2_701643.json
```

数据库任务 `14a02542-11a6-4937-940d-463c6e4231ff` 的 `raw_results.llm_outputs.polish.text` 为“你看起来不会记路啊”。已用该权威结果回填文件；对应总结提取实测为：

```text
[22:11:14-22:11:14] 你看起来不会记路啊
```

返回统计为 `source_count=1`、`input_chars=30`、`truncated=false`。

## 自动化验证

- Desktop Vitest：`19 files / 72 tests` 通过。
- Backend 定向：`9 passed`，覆盖归档字段、Both 跨类别、AI label 优先、隐私和 streaming session。
- Renderer / Electron TypeScript：通过。
- Vite 生产构建：通过，`78 modules transformed`。
- Python compileall：通过。
- VitePress 与 `git diff --check`：通过。

## 环境边界

窗口尺寸计算、Electron 类型和生产构建已验证；当前 Linux 环境未运行 Windows 打包程序截图。当前初始窗口上限为 1600×1000，详见[后续调整 Plan](../plans/2026-07-02-initial-window-1600x1000.md)。Windows 真机启动后应观察窗口居中显示，默认不是最大化状态。

---

> 📖 [返回桌面端总览 →](../desktop/README.md)
