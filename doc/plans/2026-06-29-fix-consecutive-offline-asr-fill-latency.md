# 连续离线 ASR 自动回填延迟修复

> **父文档**: [← 返回计划索引](README.md)
> **子文档**: 无

## 任务目标

- 必须先用端到端测试稳定复现：两次离线识别间隔很短时，后端已经返回第二次结果，但文本自动回填仍延迟数秒。
- 分离并记录“录音发送、ASR 响应、回填调用、回填完成”四个时间点，确认阻塞位于请求、渲染状态还是 Electron 文本注入队列。
- 在受控的即时后端响应条件下，每轮从发送录音到自动回填完成不超过 500 ms；连续与压力场景均通过。
- 保持既有录音、文件识别、剪贴板降级、状态浮窗、结果归档和旧结果防覆盖能力。

## 影响范围

- `frontend/desktop/src/services/recordingService.ts`：离线识别请求、结果可见状态与文本投递生命周期。
- `frontend/desktop/electron/main.ts` 及可能新增的可测试辅助模块：Windows 文本注入调度、超时和连续请求策略。
- `frontend/desktop/src/services/*e2e.test.ts`、`frontend/desktop/electron/*.test.ts`、`scripts/`：连续双次识别复现、500 ms 门槛和压力回归。
- `doc/desktop/`、`doc/reports/`、`doc/CHANGELOG.md`：行为约束、诊断结论和验证结果。

## 实现步骤

1. 不修改生产逻辑，先新增连续两次离线识别端到端测试；模拟后端立即返回和首轮注入阻塞，断言第二轮当前实现超过 500 ms，并输出完整时序。
2. 补充注入队列/状态机测试，区分 renderer 是否立即调用 `injectText`、Electron 是否被旧注入串行阻塞、store 是否因旧任务清理被回写。
3. 仅根据失败证据修改请求/注入调度；最新识别结果应获得有界延迟，旧任务不得覆盖新结果，超时仍保留剪贴板与结果浮窗降级。
4. 运行双次复现、至少 30 轮紧邻识别压力测试、已有录音/识别测试、全量前端测试、Renderer/Electron TypeScript、Vite 构建和 diff 检查。
5. 更新测试报告、桌面输入/识别文档和 CHANGELOG，并把实测 p50、p95、max 与环境边界写回本 Plan。

## 风险评估

- Windows UI Automation/剪贴板注入天然只能安全串行；直接并发可能导致文本乱序。修复应采用“有界等待、可取消旧操作或 latest-wins”策略，而不是无约束并发。
- 第二轮开始会中止旧 ASR 请求，但旧请求可能已经进入不可中止的 IPC/系统注入阶段；必须防止旧任务清理新任务状态，也不能丢失第二轮文本。
- Linux 自动化可以验证前端与 Electron 调度策略，不能替代 Windows QQ/微信/原生输入控件验收；Windows 真机证据单独记录。
- 500 ms 只在后端即时返回的受控 warm-path 压测中作为端到端门槛；模型冷加载和外部应用自身卡顿必须单独归因，不能混入前端指标。

## 验证记录

- 修改生产代码前，连续双次识别复现脚本稳定失败：后端即时响应，第二次发送到自动回填为 1190.2 ms，超过 500 ms。
- 修复后同一阻塞场景为 13 ms；30 轮离线识别受控压测 p95 0.0 ms、max 0.1 ms，30 轮注入队列正常压力测试全部低于 500 ms。
- 前端全量 44 passed；Renderer TypeScript、Electron TypeScript、Vite production build 和 `git diff --check` 通过。
- Windows 隔离 E2E 揭示了主线程重复同步 `clipboard.writeText` 与 STA helper 抢占剪贴板时会阻塞 Electron 事件循环；修复前第二轮约 9991.6 ms。删除主线程重复写入并增加 helper ready 握手后，全套 Windows E2E 通过，真实 textarea 第一轮 441.9 ms、第二轮 130.2 ms，两段文本均写入且低于 500 ms。
