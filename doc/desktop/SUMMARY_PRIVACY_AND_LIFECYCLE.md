# 当日总结、数据留存与桌面生命周期

> **父文档**: [← 返回桌面端总览](README.md)
> **相关文档**: [桌面语音识别](SPEECH_RECOGNITION.md) · [模型管理](MODEL_MANAGEMENT.md) · [输入与浮窗](INPUT_AND_OVERLAYS.md)

## 当日总结

“当日总结”的总结类型是固定选择，不再要求用户填写后端归档目录名：

- `Both / 所有类型` 不传 category，同时收集当日离线与实时 ASR 类别；
- `离线识别` 对应服务端类别 `一段语音转写`；
- `实时识别` 对应服务端类别 `实时转录`。

主动总结的日期默认今天，开始时间默认 `00:00`，结束时间默认打开页面时的本地当前时间。被动总结使用相同默认范围，并持久化用户后续修改。

页面提供独立“总结 Prompt”多行输入框。该值由桌面 store 持久化，主动总结和被动总结共用。后端不会把完整归档 JSON 发送给 LLM：每条记录只输出 `[开始时间-结束时间] label`，label 优先读取 `labels.ai_polished` / `llm_outputs.polish.text`，没有 AI 润色的实时记录才回退 ASR label。用户 ID、模型名、耗时、音频路径和 metadata 均不进入总结输入。

## 服务端调试数据留存

“允许服务端保存调试数据”是严格 opt-in：

- 普通 `/v1/transcribe` 的同步成功、同步失败、Celery 成功和 Celery 失败路径只有在值为 `true` 时才调用服务端音频/JSON 归档；
- `/v1/stream` 与 `/v1/tts/higgs/stream` 默认 `archive=false`，桌面实时字幕、Agent 免按键和实时 ASR+TTS 都显式发送当前开关；
- 请求省略字段时也按 `false` 处理，不能因旧默认值反向开启留存；
- Electron 用户本机的归档目录不属于“服务端保存”，继续用于本机历史和导出。

后端任务数据库仍保存完成请求和返回结果所需的运行记录；开关控制的是额外调试音频/JSON 文件归档。

## ASR AI 润色日志

同步和异步离线 ASR 在 AI 润色成功后输出结构化 INFO 日志，包含任务 ID、润色结果字符数和最终润色文本。日志不记录 API Token、Base URL 请求头或完整 LLM 配置。

允许服务端归档时，相邻 JSON 同时保存脱敏后的 `llm_outputs` 和便于总结选择的 `labels`：`labels.asr` 是原始 ASR，`labels.ai_polished` 是 AI 润色结果。Token 不会进入任一字段。

## 关闭与后台运行

设置页提供“关闭窗口后保留后台运行”，默认关闭：

- 未启用时，标题栏“关闭”会调用 `app.quit()`，同时终止托盘、快捷键和文本注入 helper；
- 只有显式启用时才隐藏主窗口并保留托盘后台运行；
- renderer 每次加载和设置变化都会将持久化值同步给 Electron main process，不再读取另一份可能过期的 `preferences.json`。

---

> 📖 [返回桌面端总览 →](README.md)
