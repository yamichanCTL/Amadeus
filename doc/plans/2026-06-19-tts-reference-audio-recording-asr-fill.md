# 2026-06-19 TTS 参考音频录音与 ASR 填充计划

## 目标

在桌面端 `模型管理 -> TTS 模型设置 -> 上传 / 保存音色` 中补齐参考音频录音输入，并确保“当前 ASR 生成”按钮可以把当前参考音频识别文本直接填入“参考音频准确文本”框。

## 影响范围

- `frontend/desktop/src/pages/Models.tsx`
- `doc/desktop/TTS_VOICE.md`
- `doc/CHANGELOG.md`

不新增后端接口。现有 `/v1/tts/higgs/reference-asr` 已能接收参考音频并调用当前 ASR。

## 实现步骤

1. 将参考音频读取工具从 `File` 扩展为通用 `Blob`，上传文件和录音结果复用同一条 Data URL 路径。
2. 在 TTS 音色弹窗的参考音频区域增加“开始录音 / 停止录音”按钮。
3. 停止录音后把录音 Blob 写入 `higgsTtsReferenceAudioDataUrl` 和 `higgsTtsReferenceAudioName`，现有音频播放控件自动可用。
4. 保持“当前 ASR 生成”按钮调用 `referenceAudioAsr()`，将识别结果 trim 后直接写入 `higgsTtsReferenceText`。
5. 弹窗关闭或组件卸载时清理正在进行的参考录音。
6. 更新变更日志和 TTS 文档。
7. 运行桌面前端类型检查与构建。

## 风险评估

- 浏览器录音依赖麦克风权限；权限被拒绝时需要给出错误提示。
- 录音格式由浏览器 `MediaRecorder` 决定，后端需继续依赖现有音频解码能力。
- 当前环境无法真实授权麦克风录音，只能通过 TypeScript/Vite 构建验证代码路径；真实录音需在桌面端运行时确认。
