# Voice Changer: 在变声器中直接切换音色

## 目标

在桌面前端变声器页面（VoiceChanger.tsx）中能够直接切换音色预设，无需跳转到模型管理页面。

## 问题根因

`VoiceChanger.tsx` 中的音色下拉框仅更新 `higgsTtsVoice`（音色名），但不加载关联的参考音频、Code JSON 等预设数据。`commonPayload()` 和 `streamConfig()` 中的 `reference_audio`、`reference_url`、`reference_text`、`reference_codes_json` 字段保持旧值（来自 Models 页面最后一次 "使用" 操作），导致音色切换实际上无效。

## 影响范围

- **页面前端** `frontend/desktop/src/pages/VoiceChanger.tsx` — 主要变更
- **CSS** `frontend/desktop/src/styles/global.css` — 可能需要少量样式

## 实现步骤

1. 在 VoiceChanger 组件中添加 `voicePresets` 状态
2. 在 `refreshRuntime()` 中增加获取 voice presets 的逻辑
3. 修改音色下拉框的 `onChange` 处理：选择音色时查找匹配的 `HiggsVoicePreset`，将所有参考字段写入 settings（同 `applyVoicePreset` 模式）
4. 在音色下拉框旁显示当前预设的参考来源信息
5. 验证三种模式（voice/text/realtime）下音色切换都生效

## 风险

- 低风险，纯前端 UI 改动
- 不涉及后端 API 变更
- 与 Models.tsx 中已有的 `applyVoicePreset` 逻辑一致，可复用
