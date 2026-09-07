# 实时对话：手动提交与声学回声消除

## 实现

原有实时对话 UI 中，自动朗读默认关闭；设置版本迁移至 41 时关闭旧的自动朗读状态。语音输入仍使用 X-ASR online decoder，配置 `endpointing: "manual"`，不加载或运行 VAD。录音期间持续返回 partial；停顿和超过原自动分段时限均不提交；用户点击结束后只产生一个 final 并交给 Codex。网络断开不提交未完成的手动录音。

回声问题的一个明确原因是：`AudioRecorder.prepare()` 为保留原始波形设置了 `echoCancellation: false`，实时对话又通过 `takePreparedStream()` 复用了这条音轨，跳过了 PcmStreamer 内默认开启 AEC 的 getUserMedia 调用。音频中转轨道也存在同样的继承问题。

修复使用独立的 WebRTC AEC 采集，根据原设备 ID 请求 `echoCancellation: {exact: true}`，检查 getSettings 的实际结果；支持 `all` 的浏览器使用所有系统播放作为参考。不修改其他功能的 raw 音轨。取消了 TTS 播放时丢弃 PCM 帧的半双工逻辑，播放和采集可以同时运行。TTS 取消使用 generation 标识，防止过期合成请求迟到后重新播放。

规范依据：[W3C Media Capture and Streams](https://w3c.github.io/mediacapture-main/#dom-mediatrackconstraintset-echocancellation)。`true` 的参考范围由浏览器决定，至少应取消远端 WebRTC 播放；`all` 明确要求尝试消除系统播放。界面区分模式，不把配置请求视为生效验证。

## 原 UI 真实端到端

脚本：`scripts/test_realtime_codex_ui.cjs`。
产物：`.runtime/realtime-codex-ui/1788796090952/report.json`。

- TTS 默认关闭，无 speak 调用。
- Chromium 麦克风采集 → 启用 AEC 的 PCM → 真实 X-ASR → 真实 Codex。
- 出现 partial 后再等待 12.5 秒，超过原 10 秒自动分段上限；结束前 final 为 0、Agent 事件为 0。
- 点击结束后 final 为 1、Agent completed 为 1。
- ASR 为 `Reply with the number five`，Codex 回复 `5`；同会话追问仍回复 `5`。

## AEC 信号实验

可复现命令（先启动 Vite 5173）：

```bash
.venv/bin/python scripts/test_browser_aec.py
```

脚本创建独立 PulseAudio 静音输出和虚拟麦克风，从实际播放输出取参考信号，叠加 80/94/113 ms 延迟及 0.6/0.18/0.08 衰减，模拟多路径房间回声。10 秒后叠加独立用户语音，形成双讲。全程连续采样，结束后自动清理测试设备。没有采集物理麦克风。

正式脚本产物：`.runtime/browser-aec/1788796755539029986/report.json`。

| 指标 | AEC 关闭 | AEC 开启 |
| --- | ---: | ---: |
| 纯回声段 RMS | 0.052639 | 0.001929 |
| 用户语音相关度中位数 | 0.551 | 0.679 |
| 用户语音幅度保留系数中位数 | 0.994 | 0.403 |

该次纯回声段抑制为 **28.72 dB**。预备轮相同声源设置测得 56.16 dB，说明收敛及设备时序会影响结果，不能把最好一次当成固定保证。双讲语音有幅度损失，不能声称完全无损。

预备轮产物 `.runtime/aec-signal-test/asr.json` 另经过真实 X-ASR：关闭 AEC 时主要识别到助手的 `This is the assistant speaking ...`；开启后识别到用户的 `The user is speaking at the same time. Please keep my voice and continue listening.`，表明用户内容能从混合信号中保留。使用不同合成说话人（far=slt、near=kal）；同一合成说话人的初步实验保留较弱，因此未宣称所有双讲条件均已解决。

这些结果验证的是模拟线性房间和浏览器采集链路，不代替用户 Windows 物理扬声器、麦克风、音量、房间混响及具体 TTS 输出路径的实测。

## 回归

- 前端 37 项通过：原实时对话、旧设置迁移、AEC 实际配置、raw 音轨替换、播放期间 PCM 连续输出、TTS 与采集并行、音频连续性、变声器等。
- 后端 33 项通过：手动连续识别、不加载 VAD、长静音、不提前 final、空录音、取消、Codex 及 X-ASR。
- TypeScript 检查和 Vite 生产构建通过。
- 修改的 Python 模块 Ruff 检查通过（保留既有 SIM105 风格项）；git diff --check 通过。

## Windows 约束错误回归修复

用户报告 `Cannot satisfy constraints` 且停留在「正在启用声学回声消除」。移除 getUserMedia 的 mandatory `echoCancellation: {exact: true}`，改为常规 AEC 偏好；`all` 模式用 ideal 协商。设备宣称支持但 applyConstraints 实际报 OverconstrainedError 时保留已获取的浏览器 AEC 音轨，不终止录音。设备未开启或未报告 AEC 时明确显示状态、继续录音并保持 TTS 关闭。采集失败时也会清理「正在启用」状态，允许重试。

回归测试通过注入与截图相同的约束错误（不是模拟 ASR 或 Agent），使用真实浏览器 PCM、X-ASR 和 Codex 验证恢复：

```bash
AEC_SIMULATE_CONSTRAINT_FAILURE=1 env -u ELECTRON_RUN_AS_NODE xvfb-run -a \
  frontend/desktop/node_modules/electron/dist/electron --no-sandbox \
  scripts/test_realtime_codex_ui.cjs
```

产物：`.runtime/realtime-codex-ui/1788797112367/report.json`。处理 1 次约束错误；仍获得实时 partial，手动结束后仅 1 次 final / Agent completed，ASR `Reply with the number five`、Codex `5`，继续追问仍 `5`，无 TTS 调用。相关前端回归 18 项通过，TypeScript 与 Vite 构建通过。测试覆盖的是同类约束失败恢复，不代表已在用户物理设备上复现驱动行为。
