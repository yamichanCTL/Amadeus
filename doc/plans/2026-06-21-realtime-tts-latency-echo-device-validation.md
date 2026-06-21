# 实时 TTS 延迟、回声隔离与设备验证

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **相关文档**: [桌面 TTS / 变声器](../desktop/TTS_VOICE.md)

## 任务目标

1. 在不重新引入单字碎片和语义改变的前提下，让较长实时语音在 VAD final 之前启动 TTS。
2. 隔离 TTS 输出与 ASR 输入，阻止输出语音被再次识别并循环合成。
3. 为输入、输出设备提供可执行测试，并验证当前 WSLg / Electron 运行环境能看到的真实设备通路。

## 影响范围

- `backend/app/api/v1/tts_api.py`：稳定前缀低延迟分段、跨 ASR job 回声文本抑制。
- `backend/tests/test_higgs_tts_api.py`：低延迟与回声保护回归测试。
- `frontend/desktop/src/services/audio.ts`：AEC 约束、播放进度、输入输出设备测试。
- `frontend/desktop/src/pages/Settings.tsx`：麦克风测试入口和检测结果。
- `frontend/desktop/src/pages/VoiceChanger.tsx`：输出测试、播放期 ASR 回声保护状态。
- `frontend/desktop/src/styles/global.css`：设备测试状态的紧凑布局。
- `scripts/test_audio_devices.sh`：WSLg Pulse 输入/输出设备诊断。
- `doc/desktop/TTS_VOICE.md`、`doc/CHANGELOG.md`：行为和验证记录。

## 实现步骤

1. 保留只使用 `stable_text` 的约束；自然标点优先，缺少标点时在足够长的稳定前缀中保留 look-ahead 后提交安全前缀，短句仍等待 final。
2. 在后端维护带来源 job 和过期时间的近期 TTS 文本；新 ASR job 与近期输出高度重合时发送 `echo_suppressed`，不再进入 TTS 队列。
3. 中转麦克风启用浏览器 AEC / 降噪，避免 ASR 克隆未经处理的 raw mic。
4. 流式 TTS 播放期间标记输出活跃；结合 AEC 和播放完成后的短保护窗口，降低扬声器回灌，同时不永久关闭麦克风。
5. 增加麦克风电平检测和指定 sink 测试音；补充 WSLg Pulse 枚举、短录音、短播放测试脚本。
6. 运行后端回归、前端类型检查与构建、设备脚本、文档构建。

## 风险评估

- 无标点稳定前缀提前提交仍可能产生非自然分段，因此必须保留最小长度和 look-ahead，且不能使用 unstable hypothesis。
- 播放期完全静音输入会截断仍在说话的用户；默认采用 AEC + 后端回声文本保护，只有输出高度相关时才抑制循环。
- WSL2 没有 `/dev/snd`，设备验证依赖 WSLg Pulse 的 `RDPSource` / `RDPSink`；Windows 侧具体物理或虚拟设备仍需在 Electron 页面用新增测试按钮确认。
- 当前工作树已有大量未提交改动，本次仅做局部补丁，不覆盖或回退已有实现。
