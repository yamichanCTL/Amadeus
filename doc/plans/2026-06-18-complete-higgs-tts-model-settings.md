# 补全 Higgs TTS 模型设置参数

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **子文档**: 暂无

## 任务目标

- 对照 `~/AI/audio/TTS/higgs-audio/webui.py` 的实际 payload，补全桌面端 `模型管理 → TTS 模型设置` 中缺失的 Higgs 参数。
- 明确 `webui.py` 没有独立的“音色相似度”数值参数；音色相似度相关能力通过注册音色、参考音频/URL、参考文本和 `reference_codes` 实现。
- 让文本 TTS、上传音频 ASR→TTS、实时 ASR+TTS 都使用同一套持久化 TTS 设置。

## 影响范围

- `backend/app/api/v1/tts_api.py`
- `backend/tests/test_higgs_tts_api.py`
- `frontend/desktop/src/pages/Models.tsx`
- `frontend/desktop/src/pages/VoiceChanger.tsx`
- `frontend/desktop/src/services/api.ts`
- `frontend/desktop/src/services/audio.ts`
- `frontend/desktop/src/store/useASRStore.ts`
- `frontend/desktop/src/styles/global.css`
- `doc/CHANGELOG.md`
- `doc/desktop/TTS_VOICE.md`

## 实现步骤

1. 对照 `webui.py` 的 `build_payload()`、控制标签表和 UI 控件，列出缺失项。
2. 在桌面端 store 中新增并迁移持久化字段：参考音频 Data URL、参考 URL、参考文本、reference_codes JSON、句首情绪/风格/韵律标签、流式首包帧数，以及 `aac` 输出格式。
3. 在模型管理 TTS tab 中补齐这些设置，并支持上传参考音频转 Data URL。
4. 扩展前端 HTTP 和 WebSocket payload，使文本、音频上传和实时流都传递完整 TTS 设置。
5. 扩展后端 Higgs proxy schema 和 payload 构造，按 `webui.py` 逻辑生成 `references` / `reference_codes` / 控制标签。
6. 更新测试、CHANGELOG 和 TTS 文档。
7. 运行 TypeScript、Vite build 和 Higgs TTS 后端单测。

## 风险评估

- 参考音频 Data URL 持久化会增加 localStorage 体积；前端限制 50 MiB 内并只在用户显式上传时保存。
- `reference_codes` 必须是形状 `[T,8]` 的 JSON，后端会校验并返回明确错误。
- 句首控制标签只适合全句前缀；内联音效标签需要用户在文本里手动放到具体位置，不作为全局模型设置自动插入。
