# 实时 TTS 延迟、回声隔离与设备测试报告

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **相关文档**: [Higgs TTS 与变声器](../desktop/TTS_VOICE.md)

## 真实 ASR→TTS 基准

输入：`data/tts/voices/Elysia/reference.wav`（9.42 秒），X-ASR 160 ms CUDA，Higgs Elysia，实时 32 ms PCM。

| 指标 | 修改前 | 修改后 |
|---|---:|---:|
| TTS 启动来源 | `final` | `partial` |
| 语音 onset → TTS start | 3.988 s | 2.933 s |
| 语音 onset → 首个有效 PCM | 4.905 s | 3.864 s |
| 服务端端到端首包 | 4.868 s | 3.827 s |
| TTS 拼接文本等于全部 ASR final | 基准脚本旧统计不支持多 job | `true` |
| 单字/微片段 | 无 | 无 |

首段从 stable partial 提前提交 `我还有好多好多话`，final 只补 `想对你说`；全部 TTS 文本拼接后与 4 个 VAD job 的 ASR final 完全一致。

## 回声隔离验证

- 中转麦克风现在请求浏览器 `echoCancellation=true`、`noiseSuppression=true`。
- 实时 ASR+TTS 拒绝名称含 `monitor`、`stereo mix`、`loopback` 等特征的直接回环输入。
- 若运行时明确报告 AEC 不可用，TTS 播放期间启用 half-duplex 输入兜底；AEC 可用时保持全双工。
- 后端保存最近 8 秒、带来源 job 的 TTS 文本；不同 ASR job 再次识别到相同或包含关系明显的文本时返回 `echo_suppressed`，不再进入 TTS 队列。
- 单元测试确认同一来源 job 不会被误杀，不同 job 的重复输出会被拦截，8 秒后自动失效。

## 当前设备实测

环境：WSL2 + WSLg PulseAudio 16.1。

| 项目 | 结果 |
|---|---|
| 默认输出 | `RDPSink`, 44.1 kHz, 2 ch |
| 默认输入 | `RDPSource`, 44.1 kHz, 1 ch |
| 回环源 | `RDPSink.monitor` |
| `/dev/snd` | 不存在，符合 WSLg 音频通过 Pulse 转发的结构 |
| 输出短测试音 | Pulse 接受并完成播放 |
| 默认输入 16 kHz 录制 | 成功，1.839 s，max `-16.8 dB` |
| 播放同时录制默认输入 | 成功，max `-15.7 dB`；相对基线没有明显突增 |
| Pulse loopback 模块 | 未加载 |

测试产物位于 `/tmp/asrapp-audio-device-test/`。`RDPSink.monitor` 是明确的输出监控源，不应作为实时 ASR+TTS 输入；Windows 物理设备、VB/BlackHole 等仍应使用桌面端新增的“测试输入 / 测试输出”按钮逐项确认。

## 自动化验证

- `backend/tests/test_higgs_tts_api.py`: 18 passed。
- Desktop TypeScript renderer/main: passed。
- Desktop Vite production build: passed。
- 真实 X-ASR→Higgs 基准：target `<= 4.0 s` passed，semantic match passed，no micro fragments passed。
- `scripts/test_audio_devices.sh`: default source/sink 与隔离探针 passed。
