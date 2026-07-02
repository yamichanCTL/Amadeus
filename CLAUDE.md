# asrapp 项目规则

## 项目定位

本项目目标是构建一个 Agentic Voice Assistant，也就是一个真正“能干活”的智能语音助手。

系统整体流程是：

用户语音或文本输入
-> ASR 或 text input
-> Orchestrator 任务编排
-> AgentRouter 选择执行器
-> Codex CLI / Claude Code CLI / OpenCode CLI 执行真实任务
-> Skill / FunctionCall 执行可控小工具
-> Context Compression 压缩上下文
-> Temporary Memory / Permanent Memory 记录经验
-> TTS 生成语音反馈
-> 返回用户

本项目不是重新实现 Codex、Claude Code、OpenCode 这样的 Agent，而是把它们作为核心执行器接入语音助手工作流。

## 核心原则

1. 不要重新造 Agent。
2. Agent 核心必须直接使用现有 CLI 工具，例如 Codex CLI、Claude Code CLI、OpenCode CLI。
3. 本项目的 Agent 层只能做 CLI Adapter、Router、日志、权限、超时、结果结构化。
4. 不要在本项目中重新实现代码理解、代码修改、多步规划、终端自主执行等完整 Agent 能力。
5. 大任务交给 Codex CLI / Claude Code CLI / OpenCode CLI。
6. 小而确定的能力才做成 Skill 或 FunctionCall。
7. 发现旧架构不合理时，允许小步重构，不要在坏结构上继续堆功能。
8. 不要为了兼容旧设计而制造更大的技术债。
9. 不要把 ASR、TTS、Agent、Memory、Skill、日志、配置全部写进一个大文件。
10. 每一轮改动都必须保持最小可运行验证。

## 第一阶段目标

第一阶段只做最小闭环，不急着接真实麦克风、真实 ASR、真实 TTS。

最小闭环是：

文本输入模拟
-> Orchestrator
-> AgentRouter
-> Codex / Claude Code / OpenCode CLI Adapter
-> 如果 CLI 不可用，则 fallback 到 MockAgent
-> 返回结构化 AgentRunResult
-> Context Compressor 生成摘要
-> Temporary Memory 写入 JSONL
-> Mock TTS 生成文本反馈
-> Structured Logger 记录执行链路
-> Demo 输出最终结果

第一阶段必须提供 demo 命令，例如：

```bash
python -m asrapp.demo.text_to_agent_to_tts_demo "分析项目结构"
````

CLI 不存在时不能崩溃，必须降级到 MockAgent。

## Agent CLI 设计要求

必须支持这些 CLI Agent：

* Codex CLI
* Claude Code CLI
* OpenCode CLI
* MockAgent fallback

不要写死某一个 Agent。

建议抽象：

* `CliAgentAdapter`
* `CodexCliAdapter`
* `ClaudeCodeCliAdapter`
* `OpenCodeCliAdapter`
* `MockAgentAdapter`
* `AgentRouter`
* `AgentRunRequest`
* `AgentRunResult`

`AgentRunRequest` 至少包含：

* task
* cwd
* agent_name
* timeout_seconds
* dry_run
* extra_args
* env

`AgentRunResult` 至少包含：

* agent_name
* success
* available
* exit_code
* stdout
* stderr
* summary
* started_at
* finished_at
* duration_seconds
* command
* artifacts

所有 CLI 调用必须：

1. 支持指定 cwd；
2. 支持 timeout；
3. 捕获 stdout；
4. 捕获 stderr；
5. 捕获 exit code；
6. 返回结构化结果；
7. 记录日志；
8. CLI 不存在时返回 unavailable，而不是抛异常导致系统崩溃。

## CLI 可用性检查

需要检查：

```bash
which codex || true
codex --help || true

which claude || true
claude --help || true

which opencode || true
opencode --help || true
```

如果命令不存在，不要自动安装，不要中断流程。标记为 unavailable，并使用 MockAgent fallback。

## Orchestrator 要求

Orchestrator 是语音助手系统的大脑，但不是 Agent 本体。

它负责：

1. 接收文本输入；
2. 创建任务上下文；
3. 调用 AgentRouter 选择 CLI Agent；
4. 调用 CLI Agent Adapter 执行任务；
5. 收集结果；
6. 压缩执行上下文；
7. 写入临时记忆；
8. 生成 TTS 文本；
9. 输出最终结构化结果；
10. 记录完整 trace。

第一阶段不要做复杂多轮规划。先保证最小闭环可运行。

## Skill / FunctionCall 定位

Skill 和 FunctionCall 是可控小工具，不是第二套 Agent 框架。

适合做成 Skill 的能力：

* 读取项目元信息；
* 查找文件；
* 读取配置；
* 运行受限命令；
* 写入记忆；
* 查询记忆；
* 生成摘要；
* 获取当前 git 状态；
* 调用 TTS；
* 发送通知。

不适合做成 Skill 的能力：

* 自主大规模改代码；
* 自主规划复杂任务；
* 代替 Codex / Claude Code / OpenCode 执行项目级任务。

原则：

1. 大任务交给 CLI Agent；
2. 小工具做成 Skill；
3. Skill 必须结构化输入输出；
4. Skill 必须有权限控制；
5. Skill 必须记录调用日志。

## ASR 要求

ASR 是输入层，不是任务规划层。

第一阶段可以只做 text input 或 MockASR。

未来 ASR 模块需要抽象为：

* `ASRProvider`
* `ASRManager`
* `ASRResult`

`ASRResult` 至少包含：

* text
* normalized_text
* language
* confidence
* segments

ASR 只负责语音转文字，不负责 Agent 决策。

## TTS 要求

TTS 是输出层。

第一阶段使用 MockTTS，只返回将要播报的文本。

未来 TTS 需要支持：

* 多 provider；
* 风格选择；
* 语速选择； 
* 音色选择；
* 流式和非流式；
* 缓存；
* 失败降级。

TTS 选择逻辑应考虑：

* 任务是否成功；
* 是否是错误提示；
* 是否是执行中反馈；
* 是否是总结汇报；
* 内容长度；
* 是否适合语音播报。

## Memory / Context Compression 要求

第一阶段使用轻量 JSONL 文件即可。

建议目录：

```text
.runtime/
  logs/
  memory/
    temporary.jsonl
    permanent.jsonl
    agent_runs.jsonl
```

要求：

1. 不要把完整 stdout/stderr 无脑塞进长期记忆；
2. 长输出要压缩成摘要；
3. 临时记忆保存当前任务结果；
4. 永久记忆只保存长期有价值的信息；
5. 敏感信息不要自动写入永久记忆；
6. 记忆记录要包含 source、timestamp、summary、metadata；
7. Agent 执行经验可以写入 agent_runs.jsonl。

## 安全要求

因为系统会调用 CLI Agent 和 shell，所以必须有边界。

要求：

1. 默认工作目录限制在项目根目录；
2. 不要默认访问项目外敏感路径；
3. 禁止危险命令；
4. 禁止静默删除重要文件；
5. 支持 dry-run；
6. 支持 timeout；
7. 支持审计日志；
8. 高风险操作必须明确标记；
9. 不要自动安装未知依赖；
10. 不要执行破坏性命令。

危险命令包括但不限于：

* `rm -rf /`
* `sudo rm`
* `mkfs`
* `dd if=`
* 大范围 `chmod -R`
* 大范围 `chown -R`
* 删除 home 目录
* 清空项目目录
* 上传敏感文件

## 架构质量要求

禁止堆屎山。

发现以下情况时，应优先重构：

1. 模块职责混乱；
2. 单文件过大；
3. ASR/TTS/Agent/Memory 强耦合；
4. 重复逻辑明显；
5. 配置硬编码；
6. CLI 命令写死在业务逻辑中；
7. demo 代码污染核心模块；
8. 无类型结构；
9. 无日志；
10. 无测试；
11. 新功能只能靠复制粘贴实现。

重构原则：

1. 小步重构；
2. 每次只调整一个清晰边界；
3. 保留最小可运行；
4. 修改后运行验证；
5. 不要一次性大爆炸重构；
6. 不要只空搭目录，必须有可运行闭环。

## 推荐目录结构

如果现有项目结构不合理，可以小步演进到：

```text
asrapp/
  core/
    orchestrator.py
    config.py
    task.py
  agents/
    cli_base.py
    codex_cli.py
    claude_code_cli.py
    opencode_cli.py
    mock_agent.py
    router.py
  asr/
    base.py
    manager.py
    mock.py
  tts/
    base.py
    manager.py
    mock.py
  skills/
    base.py
    registry.py
    builtin/
  functions/
    registry.py
    executor.py
  memory/
    manager.py
    compressor.py
    temporary.py
  security/
    permissions.py
    command_policy.py
  observability/
    logger.py
    trace.py
  demo/
    text_to_agent_to_tts_demo.py
tests/
  test_agent_router.py
  test_cli_agents.py
  test_orchestrator.py
```

如果现有结构更合理，优先尊重现有结构。

## 验证要求

每轮修改后，至少运行相关验证。

优先验证命令：

```bash
python -m pytest
python -m asrapp.demo.text_to_agent_to_tts_demo "分析项目结构"
```

如果项目暂时没有 pytest，则先补最小测试。

如果 demo 失败，必须优先修复 demo，不要继续堆新功能。

## 每轮输出格式

每轮完成后必须输出：

```text
## 本轮完成

- ...

## 修改文件

- ...

## 架构判断

- 当前合理点
- 当前风险点
- 是否存在屎山风险
- 本轮如何处理

## 验证方式

- 执行命令
- 执行结果
- 失败项和修复情况

## 下一步

- ...
```

## 工作方式

默认工作方式：

1. 先扫描项目，不要盲目修改；
2. 先判断架构，不要直接堆功能；
3. 先做最小闭环，不要过度设计；
4. 先保证 demo 可运行，再扩展真实 ASR/TTS；
5. 先用 MockAgent fallback 保底，再接真实 CLI；
6. 每次只做一个可验证切片；
7. 发现坏味道先小步重构；
8. 不要重新造 Agent；
9. 不要堆屎山；
10. 保持代码可维护、可测试、可替换。

```
```
