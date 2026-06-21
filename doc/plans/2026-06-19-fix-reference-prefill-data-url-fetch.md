# 2026-06-19 修复参考文本预填充 Data URL fetch 计划

## 目标

修复 `模型管理 -> TTS 模型设置 -> 当前 ASR 生成并填充` 仍提示 `Failed to fetch` 的问题。重点验证并修复前端在调用 ASR 前把参考音频 Data URL 转 Blob 的实现。

## 影响范围

- `frontend/desktop/src/pages/Models.tsx`
- `doc/CHANGELOG.md`

## 实现步骤

1. 定位 `generateReferenceText()` 的真实失败路径。
2. 将 `dataUrlToBlob()` 从 `fetch(dataUrl)` 改为本地 Data URL/base64 解析，避免浏览器/Electron 对 `data:` fetch 的限制。
3. 保持预填充 ASR 仍复用 `/v1/transcribe`。
4. 用真实 `data/tts/voices/maoli/reference.wav` 构造 Data URL，验证解析后 Blob 大小一致。
5. 运行前端 TypeScript 检查、Vite 构建和 diff 检查。
6. 更新 CHANGELOG。

## 风险评估

- 参考音频 Data URL 可能是 base64 或 URL encoded 文本格式，需要同时支持。
- 该改动只影响本地 Data URL 转 Blob，不改变后端接口和 ASR 调用路径。
