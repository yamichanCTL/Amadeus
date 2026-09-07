# ASR → Codex 后端端到端验收

> **父文档**：[Codex 接入](../asrapp/backend/CODEX.md)

2026-09-07 在 Linux / WSL 环境实际运行
`PYTHONPATH=backend:. .venv/bin/python scripts/test_asr_codex_e2e.py`，退出码 0，`passed=true`。

参考项目为 AInews commit `31c7a1e7bfc1766ac5eee222df159b2808aabf48`。
测试使用真实 FastAPI 进程、WebSocket、FireRed VAD、X-ASR 模型和 Codex CLI `0.153.4`，没有替换识别器、模型响应或用量事件。
输入音频由本机 ffmpeg/flite 合成为 WAV，再以 128 samples 的小帧发送，未用文本冒充音频输入。

| Gate | 实测结果 |
|---|---|
| 模型目录 | Codex app-server 查询成功 |
| 真实语音识别 | `reply with the number five` |
| 每个 ASR final 只调用一次 | 1 条最终转录，1 次语音 Agent 调用 |
| Codex 回答 | `5` |
| 增量返回 | 收到 `agent.delta` |
| 完成顺序 | Agent 回答完成后才收到 WebSocket `done` |
| 模型选择 | 使用请求指定的 `gpt-6-astra`，effort=`low` |
| 真实用量 | 每轮都有非零 token 数 |
| 多轮上下文 | HTTP 追问“刚才回答了哪个数字”，同一 thread 回答 `5` |
| 精确累计 | 两轮合计 18833 tokens，等于每轮用量之和 |
| 重启恢复 | 重启 FastAPI 后，相同会话的调用数与 token 总量保持一致 |

两轮统计：输入 18823、缓存输入 9216、输出 10、推理输出 0、合计 18833；缓存输入已经包含在输入中。
这些数字属于本次应用测试，并非用户账号总用量或费用。

原始证据：`.runtime/asr-codex-e2e/20260907-225253-034d93/report.json`。

自动化还覆盖独立连接配置、错误脱敏、重复 token 通知、多模型分组、缺失用量、ASR 任务绑定、
空文本、pending 任务拒绝、真实子进程取消、断开连接清理及 VAD 分帧重叠。
协议测试中的模型是确定性子进程，用于稳定复现边界情况；它与上述真实模型验收分开。

最终回归：Python 292 passed、3 skipped；新增接入测试 12 passed；新模块 Ruff、
`git diff --check` 和 VitePress 文档构建通过。此机 Python 3.13 的默认 SelectorEventLoop
会在 aiosqlite 完成通知处等待，完整回归使用与 Linux Uvicorn 相同的 uvloop：

```bash
PYTHONPATH=backend:. .venv/bin/python -c 'import asyncio, uvloop, pytest; asyncio.set_event_loop_policy(uvloop.EventLoopPolicy()); raise SystemExit(pytest.main(["tests", "backend/tests", "-q", "--disable-warnings"]))'
```

本次范围为后端，不含实体麦克风/扬声器、TTS 播放或 Windows/macOS 的系统权限验收。
当前入口提供 Codex 对话与语义处理，不自动执行文件写入、部署等外部工具动作。


## 原有实时对话 UI 集成验证

已移除临时独立 Demo 页面，将 Codex 集成到原有 `RealtimeAgentPage`。保留侧栏、立绘、语音与文字输入、朗读和 Agent 设定布局，新增对话引擎、Codex 模型/推理强度及用量。

真实浏览器端到端产物：`.runtime/realtime-codex-ui/1788794731646/report.json`。

- 在原界面的设置中确认后端地址，再点击侧栏「实时对话」。
- 点击原有语音按钮，Chromium 文件麦克风 → PCM → X-ASR → Codex；ASR 为 `reply with the number five`，回复为 `5`。
- 点击结束语音后，仍完整收到 Agent 回答。
- 输入「我刚才让你回复哪个数字？只回复那个数字。」再次得到 `5`。
- 当前会话 2 次调用，21003 tokens（输入 20993，其中缓存 9984；输出 10）。
- 页面显示未知用量提示，清空按钮完成后端会话重置。
- 前端相关回归 28 项通过，后端 Codex 13 项通过；TypeScript 检查和 Vite 构建通过。


后续手动提交与 AEC 修复见 [实时对话：手动提交与声学回声消除](./2026-09-08-manual-asr-aec-report.md)。
