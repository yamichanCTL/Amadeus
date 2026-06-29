# 麦克风收音间断与非原始音修复

> **父文档**: [← 返回计划索引](README.md)
> **子文档**: 无

## 任务目标

- 必须先新增端到端测试，稳定复现当前录音并非纯麦克风输入，以及 PCM chunk 丢失后 WAV 时间轴被直接压缩、产生卡顿/跳变的问题。
- 离线 ASR、TTS 一句话录音等 `AudioRecorder` 路径应保留所选实体麦克风的连续原始波形，不启用浏览器 AEC、降噪或自动增益。
- 采集过程必须能识别 Worklet 缺帧并保持音频时间轴；长录音压力测试不得出现未解释的 sample gap、非有限样本或异常时长漂移。
- 保持既有麦克风预热、设备选择、回环拒绝、录音状态、MediaRecorder 兜底、实时 ASR/TTS 和文本回填功能。

## 影响范围

- `frontend/desktop/src/services/audio.ts`：麦克风约束、AudioWorklet 消息元数据、PCM 收集与 WAV 连续性处理。
- `frontend/desktop/src/services/*.test.ts`、`scripts/`：纯输入约束、缺帧复现、波形连续性和压力测试。
- `frontend/desktop/electron/e2e.ts`：必要时扩展 Windows 实体麦克风采集诊断，不修改用户设备状态。
- `doc/desktop/`、`doc/reports/`、`doc/CHANGELOG.md`：根因、行为约束和验证证据。

## 实现步骤

1. 在不修改生产采集逻辑的前提下新增端到端测试：检查实际 `getUserMedia` 约束必须关闭 AEC/NS/AGC；向生产 PCM 聚合路径注入带序号的连续正弦块并故意跳过一块，断言当前 WAV 时长缩短且边界产生不连续。
2. 为 Worklet chunk 增加单调序号/帧位置；PCM 聚合器根据帧位置检测 gap，并以零样本保持真实时间轴，同时记录丢帧指标。乱序或重复块不得破坏输出。
3. 将 `AudioRecorder` 的实体麦克风约束统一为纯输入；保留实时对话需要的回声控制策略，不跨范围更改双工防回声逻辑。
4. 运行专项缺帧测试、长录音压力测试、现有音频/录音/ASR/TTS 测试、全量前端测试、TypeScript、Vite、Windows E2E 和文档构建。
5. 更新测试报告、桌面收音文档、CHANGELOG 和本 Plan 验证记录。

## 风险评估

- 关闭 AEC/NS 后会保留更多环境噪声，但这是“原始麦克风”语义；双工实时 Agent/TTS 的回声策略不能被误改。
- 用零样本补齐缺帧可避免时间压缩和爆音，但无法恢复已经丢失的声音内容；测试必须同时限制 gap 数量，不能把大量补零当作通过。
- Worklet 消息在 renderer 繁忙时可能延迟但通常不丢失；序号必须按音频渲染帧而非消息到达墙钟时间计算，避免把调度抖动误判成音频缺失。
- Linux 自动化能验证采集算法和约束，Windows 实体声卡/驱动仍需隔离 E2E 指标辅助验收。

## 验证记录

- 修改生产代码前，专项测试稳定失败：实体麦克风约束实际为 AEC/NS 开启；跳过一个 4,096 样本 block 后，预期 12,288 样本的 WAV 仅剩 8,192 样本。
- 修复后专项 15 passed；30 秒、11,250 block、3 处缺帧压力测试恢复完整 1,440,000 样本，聚合耗时约 20.6 ms；连续两次录音帧时间轴正确重置。
- 前端全量 48 passed；Renderer/Electron TypeScript、Vite production build、Windows unpacked 目录打包通过。
- Windows 实体 DJI 麦克风 E2E 已扩展为检查实际 DSP、WAV 样本和 gap，但本轮启动被执行额度限制拒绝；未将该项标记为已验证，待额度恢复后运行 `scripts/run_amadeus_windows_e2e.ps1`。
