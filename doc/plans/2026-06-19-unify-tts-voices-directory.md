# 2026-06-19 统一 TTS 音色目录计划

## 目标

确保上传/保存的 Higgs TTS 音色统一由 `data/tts/voices/<id>/` 管理，不再让旧版 `data/higgs_voice_presets.json` 成为另一个可见音色来源。

## 影响范围

- `backend/app/api/v1/tts_api.py`
- `backend/tests/test_higgs_tts_api.py`
- `data/tts/voices/`
- `data/higgs_voice_presets.json`
- `doc/desktop/TTS_VOICE.md`
- `doc/CHANGELOG.md`

## 执行步骤

1. 审核当前音色数据位置，确认 `data/tts/voices/maoli/` 与旧版 `data/higgs_voice_presets.json` 的内容。
2. 将旧版 JSON 中尚未目录化的音色迁移为 `data/tts/voices/<id>/meta.json`、`reference.*`、`reference.txt`、`reference_codes.json`。
3. 修改后端读取逻辑：读取旧 JSON 时自动迁移到目录，最终对外返回目录中的音色 preset。
4. 将旧 JSON 内容清空为 `[]`，避免继续误导为有效音色库。
5. 补测试覆盖旧 JSON 自动迁移到统一目录。
6. 更新文档和 CHANGELOG。
7. 运行后端目标测试与编译验证。

## 风险评估

- 旧 JSON 中可能包含很大的 base64 音频，迁移时必须保持音频和文本完整。
- 已存在同名目录时，以目录内容为准，避免覆盖用户已手动整理的音色。
- 清空旧 JSON 前先完成目录迁移并通过文件存在检查。
