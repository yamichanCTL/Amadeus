# TTS 与 ASR 模型管理优化

## 任务目标

按当前桌面端工作流优化 TTS/变声器/ASR 模型管理：

- `模型管理 → TTS 模型设置` 只把“上传音色/保存音色”留在弹窗，常用音色、句首控制标签和生成参数直接展示在 TTS 模型管理页。
- 修复 `变声器/TTS → 语音转 TTS` 异常不可用的问题。
- 优化 `实时 ASR + TTS` 端到端延迟，并保留输出设备选择，支持 VB-Cable 等虚拟声卡。
- 后端音色保存到 `/home/yami/AI/asrapp/data/tts/voices/<id>/`，每个音色目录保存音频、文本和元信息。
- 变声器/TTS 页面增加音色临时选择。
- 上传参考音频时支持播放；参考文本支持调用当前 ASR 自动生成。
- 前后端移除 Vosk、Sherpa、Stream 这类不再使用的 ASR 模型入口。
- ASR 模型设置支持点击子模型展开细节配置，包含启动设备和参数。
- 修复公网 IP 后端地址使用问题，支持 `112.124.13.120:18000` 这种无协议地址。
- 前端暂时移除事件检测入口。

## 影响范围分析

- 前端：
  - `frontend/desktop/src/pages/Models.tsx`
  - `frontend/desktop/src/pages/VoiceChanger.tsx`
  - `frontend/desktop/src/services/api.ts`
  - `frontend/desktop/src/services/audio.ts`
  - `frontend/desktop/src/store/useASRStore.ts`
  - `frontend/desktop/src/App.tsx`
  - `frontend/desktop/src/components/Sidebar.tsx`
  - `frontend/desktop/src/styles/global.css`
- 后端：
  - `backend/app/api/v1/tts_api.py`
  - `backend/app/api/v1/models.py`
  - `backend/app/core/asr/registry.py`
  - `backend/app/core/asr/router.py`
  - `backend/app/config.py`
- 测试与文档：
  - `backend/tests/test_higgs_tts_api.py`
  - `backend/tests/test_engines.py`
  - `doc/desktop/TTS_VOICE.md`
  - `doc/asrapp/asr/ENGINES.md`
  - `doc/asrapp/backend/DEPLOY.md`
  - `doc/CHANGELOG.md`

## 实现步骤

1. 梳理现有 TTS、变声器、ASR 模型管理和 API 实现。
2. 后端调整：
   - 新增目录化音色存储，保留旧 JSON preset 的迁移读取能力。
   - 新增参考音频 ASR 文本生成接口。
   - 修复音频上传 ASR→TTS 请求参数和公网 URL 规范化。
   - 只暴露当前使用的 ASR 引擎。
3. 前端调整：
   - TTS 模型管理页拆出常用配置；弹窗聚焦上传/保存音色。
   - 变声器页增加音色选择、输出设备刷新、临时音色覆盖。
   - WebSocket/HTTP URL 统一支持无协议公网地址。
   - 实时 ASR+TTS 使用更低延迟的 PCM chunk 和配置默认值。
   - 移除事件检测入口。
   - ASR 子模型增加可展开详细设置并按配置加载。
4. 更新测试，覆盖音色目录化保存、音频 ASR→TTS、公网地址规范化、ASR 引擎过滤。
5. 运行后端目标测试、Python 编译、前端 TypeScript/Vite 构建等验证。
6. 更新 CHANGELOG 与相关文档。

## 风险评估

- 现有工作树改动很多，必须避免回滚用户已有文件。
- 实时端到端延迟受 Higgs 服务和 ASR 模型实际推理速度影响，本次只能在前端采集、chunk、WebSocket 配置、默认参数和音频播放链路上优化。
- 公网 IP 真实连通性依赖外部服务状态；本地测试会覆盖 URL 规范化和请求构造，真实公网连通需要服务端在线。
- 删除 Vosk/Sherpa/Stream 入口会影响旧文档和旧测试，需要同步更新。
