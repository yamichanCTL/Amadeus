# Runner — 轻量运行时管线

> **父文档**: [← 返回 asrapp 总览](../README.md)
> **子文档**:
> - [编排器](ORCHESTRATOR.md) — 核心管线调度
> - [Agent 适配器](AGENTS.md) — 5 个 CLI Agent 封装
> - [TTS 引擎](TTS.md) — 3 种语音合成
> - [记忆系统](MEMORY.md) — JSONL 临时/持久记忆
> - [技能系统](SKILLS.md) — 内置小工具

---

## 定位

Runner 是独立于 Backend 的轻量级管线库，不依赖 FastAPI/SQLAlchemy/Celery。用于：

- 命令行演示（最小闭环验证）
- 嵌入式语音助手调用
- 快速原型开发

## 与 Backend 的关系

```
Backend (FastAPI)          Runner (Standalone)
     │                          │
     ├─ HTTP/WS 服务            ├─ CLI demo
     ├─ 多用户                  ├─ 单会话
     ├─ Celery 异步             ├─ 同步执行
     ├─ 数据库持久化             ├─ JSONL 文件
     └─ 生产级                   └─ 原型/演示
```

两者共享 TTS/ASR 适配层的设计模式，但 Runner 完全不依赖 Backend。

## 目录结构

```
runner/
├── core/
│   ├── orchestrator.py    # 核心编排: text→agent→compress→memory→TTS
│   ├── config.py          # 路径配置、超时、默认值
│   └── task.py            # AgentRunRequest, AgentRunResult, PipelineTiming
├── agents/
│   ├── cli_base.py        # CliAgentAdapter 抽象基类
│   ├── claude_code_cli.py # Claude Code CLI 适配器
│   ├── codex_cli.py       # Codex CLI 适配器
│   ├── opencode_cli.py    # OpenCode CLI 适配器
│   ├── mock_agent.py      # 永远可用的 fallback
│   └── router.py          # 优先级路由 + 偏好检测
├── asr/
│   ├── base.py            # ASRProvider, ASRResult
│   └── whisper_adapter.py # faster-whisper 适配
├── tts/
│   ├── base.py            # TTSProvider, TTSRequest, TTSResult
│   ├── mock.py            # MockTTS（纯文本，无音频）
│   ├── gpt_sovits.py      # GPT-SoVITS HTTP API
│   ├── voxcpm.py          # VoxCPM2 高音质
│   ├── manager.py         # TTSManager + 风格选择
│   └── style.py           # 5 种 SpeechStyle
├── memory/
│   ├── manager.py         # MemoryManager 协调器
│   ├── temporary.py       # JSONL 文件操作
│   └── compressor.py      # 上下文压缩
├── skills/
│   ├── base.py            # SkillCall, SkillResult
│   ├── registry.py        # 技能注册表
│   ├── executor.py        # FunctionExecutor
│   └── builtins/          # 5 个内置技能
├── voice/
│   └── converter.py       # 语音转换管线
├── observability/
│   └── logger.py          # structlog 结构化日志
└── demo/
    └── text_to_agent_to_tts_demo.py  # CLI 演示入口
```

## 最小闭环

```bash
python -m runner.demo.text_to_agent_to_tts_demo "分析项目结构"
```

流程：

```
文本输入 → Orchestrator → AgentRouter → CLI Agent (或 MockAgent)
→ 结果压缩 → Memory 写入 → TTS 合成 → 输出
```

---

> 📖 [编排器详解 →](ORCHESTRATOR.md) | [Agent 适配器 →](AGENTS.md) | [TTS →](TTS.md)
