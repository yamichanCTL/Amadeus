# 修复录音识别请求并增加麦克风音频中转混音

> **父文档**: [← 返回变更计划目录](../README.md)
> **相关文档**: [桌面语音识别](../desktop/SPEECH_RECOGNITION.md) · [变声器 / TTS](../desktop/TTS_VOICE.md)

## 任务目标

- 修复桌面语音识别停止录音并上传后出现 `Failed to fetch` / 500 的问题。
- 在变声器 / TTS 工作台增加共享音频中转：启用后只接管一次真实麦克风，常态透传到当前输出设备；音效、普通 TTS 和流式 TTS 注入同一混音总线后输出到虚拟声卡或系统设备。
- 保持现有离线录音识别、实时 ASR、TTS 音色和输出设备设置可继续使用。

## 根因与影响范围

- `backend/app/db/models.py`、`backend/app/db/crud.py`
  - 产品代码删除说话人分离字段后，已有 SQLite 表仍保留 `diarize_enabled NOT NULL`；创建录音识别任务时没有写该列，导致插入失败。
  - 保留该列作为数据库兼容字段并固定为 `false`，不恢复说话人分离产品能力。
- `frontend/desktop/src/services/audio.ts`
  - 新增共享 `AudioRelayMixer`，统一管理真实麦克风、输出设备、音频解码和 PCM16 流式注入。
  - 录音器和 PCM 推流器支持复用中转器提供的麦克风克隆流，避免同一页面重复接管物理麦克风。
- `frontend/desktop/src/pages/Transcribe.tsx`
  - 加固录音开始错误处理和网络错误提示，确保失败后状态可以恢复。
- `frontend/desktop/src/pages/VoiceChanger.tsx`
  - 增加中转启停与状态展示；TTS、音效、实时 PCM 全部优先进入共享混音总线。
- `backend/tests/`、前端测试/类型检查
  - 增加旧数据库兼容回归，并验证音频中转代码的类型和生产构建。

## 实现步骤

1. 恢复隐藏的 legacy `diarize_enabled` ORM 映射，由 `create_task()` 固定写入 `false`，验证现有数据库无需重建即可创建任务。
2. 为前端转写请求增加包含目标地址的网络失败说明；录音启动异常时清理录音器和 UI 状态。
3. 实现共享音频中转器：真实麦克风接入增益节点后直接输出，TTS/音效解码后接入相同 destination，PCM16 chunk 使用同一 AudioContext 排队播放。
4. 让实时 ASR 和一句话录音在中转开启时使用真实麦克风轨道的 clone，由中转器继续持有唯一原始采集流。
5. 在变声器 / TTS 页面增加中转控制和路由状态，切换输出设备时实时更新 sink。
6. 执行真实短录音 HTTP 上传、后端目标测试、TypeScript、Vite、Python compileall 和 diff 检查。
7. 更新 CHANGELOG、桌面语音识别和 TTS 文档。

## 风险评估

- 麦克风透传到实体扬声器会产生回授；界面需要明确提示优先选择 VB、BlackHole 等虚拟声卡或耳机。
- `AudioContext.setSinkId()` 依赖 Electron/Chromium 支持；代码可验证，真实虚拟声卡设备仍需在目标桌面环境实测。
- Web Audio 解码支持由 Chromium 决定；常见 WAV/MP3/FLAC/OGG 可走解码节点，Higgs 原始 PCM 则走专用 PCM16 注入路径。
- legacy 数据库列暂时保留，只用于兼容已有数据库；后续正式迁移工具可再安全删除物理列。

## 验证结果

- 修复前：同一段 0.8 秒 `audio/webm` 静音录音经后端直连和 Vite `/v1` 代理上传均返回 500。
- 修复后：经 `http://127.0.0.1:5173/v1/transcribe` 上传返回 200，任务状态为 `success`，SQLite 任务行 `diarize_enabled=0`。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit`：通过。
- `node node_modules/vite/bin/vite.js build`：通过，75 modules transformed。
- `.venv/bin/python -m compileall -q backend/app`：通过。
- `doc/npm run build`：通过。
- `git diff --check`：通过。
- 目标 pytest 在该工作区继续出现既有的无输出挂起并由 timeout 终止；本次以真实运行中后端 HTTP 回归替代。真实麦克风和虚拟声卡硬件路由仍需在目标 Electron 桌面环境确认。
