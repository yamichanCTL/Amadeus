# 实时 ASR → 流式文本 → Higgs 流式 TTS 一秒首音频计划

> **父文档**: [← 返回变更计划目录](../README.md)
> **相关文档**: [桌面 TTS 与实时语音](../desktop/TTS_VOICE.md)

## 任务目标

- 使用模型管理中已配置的 X-ASR 流式模型持续产出 partial/final 文本。
- 将稳定的增量文本及时送入 `8002` Higgs Audio v3 流式 PCM 接口，不等待整句 final。
- 浏览器收到首个 PCM chunk 后立即播放；目标为从用户开口到首个可播放音频约 1 秒。
- 用真实服务和自动化测试分别证明协议链路、首包时序与回归安全。

## 影响范围

- `backend/app/api/v1/tts_api.py`: 实时 WebSocket 的 ASR partial 增量切分、TTS 调度、首包 timing。
- `backend/app/core/streaming/session.py`: 仅在真实基线表明确有必要时调整 partial 产出节奏。
- `frontend/desktop/src/services/audio.ts`: 流式事件与时序字段。
- `frontend/desktop/src/pages/VoiceChanger.tsx`: 连续 PCM 播放、增量文本状态和一秒目标展示。
- `backend/tests/test_higgs_tts_api.py` 及相关测试：稳定增量文本和流式首包测试。
- `doc/desktop/TTS_VOICE.md`、`doc/CHANGELOG.md`、测试报告：实现与实测结果。

## 实现步骤

1. 对照 Boson 官方文档和本地 Higgs 参考实现，确认 `stream=true`、`response_format=pcm` 和首包读取语义。
2. 直接测量 8002 的单独 TTFA，并检查 8000 当前 WebSocket 链路和 X-ASR 配置，拆分 ASR partial、TTS 首包、浏览器可播放三个阶段。
3. 以最长公共前缀/稳定边界提取尚未合成的增量文本；达到最小可读片段或遇到标点时立即启动 Higgs 流式请求，final 只补发剩余文本。
4. 保持音频 job 顺序并避免 partial 重复合成、final 重播和新 utterance 错误取消；首个 PCM 包立即转发并由前端 PCM player 播放。
5. 添加单元/协议测试，运行 TypeScript、Vite、Python、pytest 和 diff 检查。
6. 使用真实 8002/8000 服务重复测量，记录首个 ASR partial、Higgs 首 PCM、端到端首音频；若超过目标，继续定位模型、VAD 或缓冲等待。
7. 更新 CHANGELOG、专题文档和逐项测试报告。

## 风险评估

- “用户开口”依赖 VAD 起点；浏览器麦克风的硬件缓冲和 AudioContext 调度会造成环境差异，报告必须区分后端首包与真实扬声器出声。
- 过早把单字 partial 送入 TTS 会产生错误或断裂语音；需要稳定文本阈值，同时确保不为了完整性重新等待 final。
- 本地 Higgs 首包速度受 GPU 占用和预热影响；需分别记录冷启动与热启动。
- 当前工作区已有大量未提交改动；只做最小局部补丁，不覆盖无关变更。

## 执行结果

- 8000 启动阻塞定位为 `backend/app/main.py` 缺少 `Any` 导入，修复后 `/v1/health` 恢复。
- 8002 单独热启动两字 TTS 首 PCM 为约 `0.451s`；后续预热请求稳定在约 `0.22–0.38s`。
- 原方案“第一个 partial 合成一次并跳过 final”改为累计 hypothesis 去重、增量分段、单队列顺序合成。
- 额外发现并修复 VAD 冷加载发生在用户开口后、同步 X-ASR/VAD 阻塞 WebSocket、32 KB 首包聚合、前端每个 TTS job 重置播放器和 codec 首帧硬编码为 0。
- 真实链路最终以 32 ms PCM 块、X-ASR 160 ms CUDA、Elysia 音色测得：VAD `0.100s`、首 partial `1.123s`、首 PCM `1.487s`，partial→首 PCM `0.363s`；后端 onset 口径为 `1.465s`。
- 目标按真实音频内容和硬件存在抖动；当前实机结果落在约 1 秒量级，未把 mock 延迟当成实测结论。
