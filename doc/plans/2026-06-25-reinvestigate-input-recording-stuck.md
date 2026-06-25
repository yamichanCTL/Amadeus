# 重新排查输入失败与录音卡住

> **父文档**: [← 返回计划索引](README.md)
> **子文档**: 无

## 任务目标

- 修复 QQ 等应用中自动输入失败或偶发失败的问题，避免状态浮窗抢焦点或热键状态影响粘贴。
- 修复离线 ASR / TTS 录音卡在“语音输入中”、没有进入 thinking 的问题。
- 修复 TTS 录音收音卡顿导致 ASR 识别异常的问题。

## 影响范围

- `frontend/desktop/electron/main.ts`：状态浮窗焦点策略、Windows 文本注入策略。
- `frontend/desktop/src/services/audio.ts`：录音启动/停止超时、音频约束、MediaRecorder 稳定性。
- `frontend/desktop/src/services/recordingService.ts`：录音状态机与停止路径。
- `frontend/desktop/src/pages/VoiceChanger.tsx`：TTS 录音状态浮窗与录音路径。
- `doc/desktop/TTS_VOICE.md`、`doc/CHANGELOG.md`：同步说明。

## 实现步骤

1. 让录音状态在点击/热键开始时立即进入 `recording`，并对麦克风启动、停止增加超时和错误兜底。
2. TTS 录音按钮完整控制状态浮窗：开始显示 recording，停止立刻切 thinking，完成/失败明确隐藏或显示结果。
3. 调整 `AudioRecorder` 约束和录音 chunk 策略，避免强制 16k + AEC/NS 造成驱动/Opus 断续。
4. 优化 Windows 注入：浮窗在非 result 阶段不可聚焦；注入 helper 支持优先向 focused element 使用 UIAutomation Insert/SetValue，失败再 Ctrl+V。
5. 跑 TypeScript、Vite build 和 diff check 验证。

## 风险评估

- QQ 聊天框属于外部应用，无法在当前 Linux 环境直接端到端验证；代码侧需要保留多策略 fallback 和诊断日志。
- 录音约束从强制 16k 改为设备原生采样后，后端仍需接受 WebM/Opus 由服务端重采样。
- stop 超时兜底可能返回已收集 chunk 的部分音频，但比状态机永久卡住更可控。
