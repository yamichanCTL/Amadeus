# ASR 立即回填与 TTS 纯麦克风采集修复

> **父文档**: [← 返回计划索引](README.md)
> **子文档**: 无

## 任务目标

- 后端返回最终 ASR 文本后，前端立即启动文本回填；从响应接收到发起回填的前端开销必须低于 500ms。
- TTS 的录音与实时 ASR 输入始终直接采集用户选择的物理麦克风，不再复用包含 TTS、音效或虚拟声卡输出的中转链路。
- 先用自动化脚本稳定复现并锁定上述问题，再实施修复和既有功能回归。

## 影响范围

- `frontend/desktop/src/services/recordingService.ts`：最终结果投递时序、离线录音输入源。
- `frontend/desktop/src/pages/VoiceChanger.tsx`：TTS 录音和实时 ASR 的输入源隔离。
- `frontend/desktop/src/services/audio.ts`：纯麦克风约束及可测试的采集边界。
- `frontend/desktop/src/services/*.test.ts`、`scripts/`：端到端时序压测与音频输入隔离回归。
- `doc/desktop/`、`doc/reports/`、`doc/CHANGELOG.md`：行为约束和验证结果。

## 实现步骤

1. 新增可失败的端到端测试：模拟后端最终响应，记录响应接收、React/store 可见更新、文本注入调用之间的延迟，并以 500ms 为硬门槛循环压测。
2. 新增音频输入隔离测试：即使中转开启，离线 ASR、TTS 录音与实时 ASR 也不得调用 `createInputStream()`，只允许显式扬声器录制走 loopback。
3. 将最终文本的可见状态更新和注入调度放在任何归档、telemetry、播放或其他异步操作之前；消除不必要的首轮轮询等待。
4. 将 TTS 语音录制和实时识别改为独立 `getUserMedia` 物理麦克风流，中转仅负责把麦克风/TTS/音效送到用户选择的输出设备。
5. 运行定向单测、500ms 循环压测、TypeScript、Vite 构建、后端相关回归及 diff 检查。
6. 更新桌面文档、CHANGELOG 和逐项测试报告。

## 风险评估

- 浏览器单独打开麦克风与中转同时占用同一设备，个别独占型驱动可能拒绝第二路采集；失败时必须明确报错，不能静默回退到混音输入。
- 500ms 指标仅约束“前端收到最终 ASR 响应后到提交文本回填”的额外延迟，不把模型推理、网络传输或外部应用自身处理耗时伪装成前端延迟。
- Linux 环境无法真实验证 Windows QQ/微信文本控件与具体声卡驱动；自动化测试必须覆盖调用时序和输入源边界，Windows 硬件验收单独记录。

## 验证记录

- 专项端到端与输入隔离：5 passed；220 ms ASR 响应模拟下停止录音到 DOM 显示为 368 ms。
- 前端 30 轮回填压力：p50 5.7 ms、p95 7.4 ms、max 7.9 ms，全部低于 500 ms。
- 前端全量：39 passed；Renderer/Electron TypeScript 与 Vite build 通过。
- 后端 `test_higgs_tts_api.py` + `test_api.py`：18 passed；VitePress build 通过。
- 后端完整套件在本环境停在第三个 TestClient 用例且 90 秒无输出，已中止；本次未修改后端代码。
- 真实 Higgs→SenseVoice 样本：warm HTTP 222.5 ms，识别文本与输入一致；首次冷加载 10.356 s，单独记录、不计入 warm 回填门槛。
