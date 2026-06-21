# CHANGELOG

> **父文档**: [← 返回文档索引](README.md)
> **子文档**:
> - [桌面端文档](desktop/README.md)

## [2026-06-21] Amadeus 桌面录音、浮窗、跨应用输入与音频路由

- **类型**: feat / fix / refactor / docs
- **描述**: 桌面产品更名为 Amadeus；全局预热麦克风并以 100 ms timeslice 保护开头采音，状态浮窗移到屏幕中下部并增加真实电平波形和动态 thinking。录音、上传/轮询、后端任务与实时流增加统一强制停止；Windows 自动输入改为剪贴板优先加 user32 Ctrl+V。实时预览压缩为秒级时间范围加文本，字幕框增加关闭/设置按钮和动态尺寸配置。移除固定 body 最小宽度并加入 980/760/560 响应式断点。音频中转提升为持久应用级单例，DJI 等真实输入常态透传，TTS/音效叠加到 CABLE 等虚拟输出。设置新增用户 ID 并写入 Electron `archive/userid`，同时传给文件和实时归档。
- **验收工具**: 新增隔离的 Windows `--amadeus-e2e` 模式和 `scripts/run_amadeus_windows_e2e.ps1`，可实际验证 user32 粘贴、动态浮窗按钮、580×500 响应式布局，以及 DJI→CABLE Input/Output 的 WebAudio 回环，不触碰用户当前编辑器输入框。
- **影响范围**: `frontend/desktop/`、`backend/app/api/v1/transcribe.py`、`backend/app/schemas/transcribe.py`、`backend/app/tasks/asr_task.py`、`backend/tests/test_amadeus_desktop.py`、`doc/desktop/`
- **测试报告**: [Amadeus 桌面输入、浮窗与音频路由测试报告](reports/2026-06-21-amadeus-desktop-capture-overlay-routing-test-report.md)
- **Plan**: [Amadeus 录音、浮窗、输入注入与音频路由改造](plans/2026-06-21-amadeus-capture-overlay-routing-userid.md)

## [2026-06-21] 修复实时停止、补齐状态反馈与历史日期筛选

- **类型**: fix / feat / docs
- **描述**: 实时 ASR 停止改为立即、幂等地停止采集和关闭连接，补齐连接接受、模型加载、就绪和配置完成反馈；实时变声和免按键 Agent 同步消费连接状态。历史记录增加文本、语言及包含边界日的起止日期筛选，时间精确到秒，并区分清空筛选与删除记录。新安装默认使用右 Alt 触发语音识别，旧默认鼠标中键自动迁移；Windows 提供全局右 Alt hook。新增后端、桌面、Android、第三方模型和环境迁移分层指南。
- **影响范围**: `frontend/desktop/`、`doc/asrapp/installation/`、`doc/desktop/SPEECH_RECOGNITION.md`
- **Plan**: [实时识别停止、状态反馈、历史筛选与环境迁移](plans/2026-06-21-realtime-stop-status-history-install-right-alt.md)

## [2026-06-21] 降低实时 TTS 延迟并隔离输出回声

- **类型**: fix / perf / docs
- **描述**: 保留 stable-only 和词边界约束，将无标点中文的提前提交改为 8 个稳定字、1 字 look-ahead，并用 jieba 避免切断词语；真实 Elysia 长音频首次 TTS 从 final 改为 partial，语音 onset 到首 PCM 从 4.905 s 降至 3.864 s，拼接文本仍与全部 ASR final 一致且无微片段。中转麦克风启用 AEC/降噪，实时链路拒绝 monitor/stereo-mix/loopback 输入，AEC 不可用时播放期自动 half-duplex；后端新增跨 job 的 8 秒 TTS 文本回声保护和 `echo_suppressed` 事件。桌面端增加输入电平测试、指定输出测试音和播放队列保护窗口，并完成 WSLg `RDPSource` / `RDPSink` 实测。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/Settings.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`scripts/benchmark_realtime_asr_tts.py`、`scripts/test_audio_devices.sh`、`doc/`
- **测试报告**: [实时 TTS 延迟、回声隔离与设备测试报告](reports/2026-06-21-realtime-tts-latency-echo-device-test-report.md)
- **Plan**: [实时 TTS 延迟、回声隔离与设备验证计划](plans/2026-06-21-realtime-tts-latency-echo-device-validation.md)

## [2026-06-21] 修复流式模型失败后 WebSocket 卡死

- **类型**: fix / docs
- **描述**: X-ASR CUDA recognizer 创建后先执行真实静音 decode warm-up，成功后才标记模型已加载；运行期 native decode 失败会撤销 loaded 状态。后端将 CUDA/cuDNN 运行时异常稳定返回为 `model_not_loaded`（“模型没有加载”），将 CUDA/ONNX 内存分配失败返回为 `gpu_out_of_memory`（“显存不足”）。`/v1/stream` 与 `/v1/tts/higgs/stream` 发送带 `fatal=true` 的错误后立即关闭 WebSocket，并通过 abort 路径丢弃失败 decoder，避免再次 `finish()` 导致连接卡死。
- **影响范围**: `backend/app/core/model_errors.py`、`backend/app/core/model_manager.py`、`backend/app/core/asr/engines/x_asr.py`、`backend/app/core/streaming/session.py`、`backend/app/api/v1/stream.py`、`backend/app/api/v1/tts_api.py`、`backend/tests/`、`doc/asrapp/backend/`
- **Plan**: [修复流式模型失败后 WebSocket 卡死](plans/2026-06-21-fix-streaming-model-failure-hang.md)

## [2026-06-21] 修复实时 TTS 单字碎片、语义改变和分段停顿

- **类型**: fix / perf / docs
- **描述**: 撤销“首个 unstable partial 立即合成”的激进策略；partial 现在只使用连续 hypothesis 的稳定文本，首段至少 6 个字符、后续至少 8 个字符，并且只在自然标点或安全空格边界提交，短句统一等待 final 整句合成。final 修正已播前缀时不再按字符位置切片，避免产生错误后缀。Higgs PCM 增加 20 ms 在线边界静音门控，保留自然短停顿并压缩长首尾静音；有效语音后连续静音达到 900 ms 会提前关闭上游请求，避免阻塞下一段。真实短句只提交 `你好，世界` 一个 TTS 片段，文本与 ASR final 完全一致，播放缓冲 underrun 为 0 ms，裁掉 1040 ms 边界静音。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`scripts/benchmark_realtime_asr_tts.py`、`doc/desktop/TTS_VOICE.md`
- **测试报告**: [实时 TTS 语义与连续性测试报告](reports/2026-06-21-realtime-tts-semantic-quality-test-report.md)
- **Plan**: [修复实时 TTS 语义碎片计划](plans/2026-06-21-fix-realtime-tts-semantic-fragmentation.md)

## [2026-06-21] 实时 X-ASR 增量文本到 Higgs 流式 TTS 延迟优化

- **类型**: feat / fix / perf / docs
- **描述**: 将累计 X-ASR partial 改为有序、去重的增量文本 TTS 队列，final 只补发剩余文本；配置阶段预热 VAD、X-ASR 与 Higgs 音色后再打开麦克风；VAD/X-ASR 推理移出 WebSocket 事件循环；Higgs 原始 PCM 首包直接转发，恢复 `initial_codec_chunk_frames=1`，前端跨增量 job 连续播放。真实 2.32 秒中文录音在 X-ASR 160 ms CUDA + Elysia 上测得语音 onset 到首 PCM 1.487 秒，ASR 首 partial 到首 PCM 0.363 秒。
- **影响范围**: `backend/app/main.py`、`backend/app/api/v1/tts_api.py`、`backend/app/core/asr/engines/x_asr.py`、`backend/app/core/streaming/`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`scripts/benchmark_realtime_asr_tts.py`、`backend/tests/`、`doc/desktop/TTS_VOICE.md`
- **测试报告**: [2026-06-21 实时 ASR→TTS 延迟测试报告](reports/2026-06-21-realtime-asr-tts-1s-test-report.md)
- **Plan**: [实时 ASR→流式文本→Higgs 流式 TTS 计划](plans/2026-06-21-realtime-asr-streaming-text-higgs-1s.md)

## [2026-06-21] 修复语音转 TTS 报错 "Part exceeded maximum size of 1024KB"

- **类型**: fix
- **描述**: 
  - **根因1 (WebSocket 流式)**: `_send_stream_tts_events()` 在 `tts_chunk` 逐 chunk 送达音频后，将全部合成音频 base64 编码为单条 WebSocket 消息发送，长语音会超出 `websockets` 库默认 1MB 限制。**修复**: 移除冗余的完整合并 `tts` 事件。
  - **根因2 (HTTP multipart 上传 — 用户实际报错)**: Starlette 在 `Request._get_form()` 和 `MultiPartParser.__init__` 两处均硬编码 `max_part_size=1024*1024`（1MB）。`_get_form()` 将该值作为 keyword 传入 `MultiPartParser`，仅修改类变量无法覆盖。**修复**: monkey-patch `MultiPartParser.__init__`，无条件将 `max_part_size` 替换为 `settings.max_upload_size_bytes`（500MB）。
- **影响范围**: `backend/app/main.py`、`backend/app/api/v1/tts_api.py`
- **Plan**: [plans/2026-06-21-fix-websocket-1024kb-limit.md](plans/2026-06-21-fix-websocket-1024kb-limit.md)

## [2026-06-21] 变声器音色直接切换、默认音色改为 Elysia、移除 TTS 延迟面板、优化开发调试台

- **类型**: fix / refactor
- **描述**: 
  - 修复桌面变声器/TTS 页面中音色下拉只更新音色名但不加载预设参考信息的问题。切换音色时自动查找已保存预设并应用全部引用字段。
  - TTS 默认音色从 `'default'` 改为 `'Elysia'`（覆盖 store 初始值、merge 回退、组件回退、API 层回退、WebSocket 层回退）。
  - 移除变声器/TTS 页面的延迟面板（`.voice-latency-panel`），相关实时 TTS 延迟信息迁移到开发调试台的 telemetry 追踪中。
  - 修复模型管理 ASR 页打开时 SenseVoice 自动展开的问题（`expandedAsrEngine` 初始值改为空字符串）。
  - **开发调试台重构**：事件按任务链路（trace）分组，每条链路默认可折叠，点击展开查看阶段瀑布图和详情；无 traceId 的事件（如定时健康检查）收入可折叠的「其他事件」区；新增事件/任务链路/平均/P95/错误五栏概览。
- **影响范围**: `frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-21-voice-changer-preset-switching.md)


## [2026-06-20] 修复 WebSocket 连接超时并延迟 VAD 加载

- **类型**: fix
- **描述**: 
  - 后端 `/v1/stream` 在 `websocket.accept()` 后立即发送 `{"type":"accepted"}` 消息，避免 FireRed VAD 加载期间客户端无响应
  - 后端增加 `{"type":"loading"}` 心跳消息，在模型加载超过 3s 时周期发送，防止客户端误判连接死掉
  - `StreamingASRSession` 将 VAD 模型创建延迟到首次 `accept_audio()`（对齐 X-ASR 参考实现的延迟加载模式），WebSocket 连接现在瞬间完成不受模型加载影响
  - 前端 WebSocket 连接超时从 5s 增加到 15s
  - 前端增加 `accepted`/`loading` 消息类型处理
  - 前端错误诊断信息增加具体建议：Nginx 反向代理 WebSocket 配置、后端启动命令、Vite 启动命令
- **影响范围**: `backend/app/api/v1/stream.py`、`backend/app/core/streaming/session.py`、`frontend/desktop/src/services/audio.ts`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-fix-websocket-connection-timeout.md)

## [2026-06-20] 修复实时识别握手并重排识别预览

- **类型**: fix / refactor / docs
- **描述**: 修复 Uvicorn 热重载工作子进程退出后只剩监听父进程导致 HTTP/WS 全部超时的问题，后端改用无 reload 运行方式；`/v1/stream` 和实时 TTS WebSocket 在接受连接后将首次 FireRed VAD/session 初始化移到工作线程，避免阻塞事件循环并触发前端 5 秒握手超时。桌面实时 ASR 会依次尝试显式后端 WebSocket 和 Vite 同源 `/v1` 代理，只有全部失败才显示包含实际地址的诊断。语音识别页面按 ImageGen 布局参考改为单列宽卡片，将识别预览移动到上传区下方，识别设置和助手继续排列在其后。
- **影响范围**: `backend/app/api/v1/stream.py`、`backend/app/api/v1/tts_api.py`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/Transcribe.tsx`、`frontend/desktop/src/styles/global.css`、`doc/desktop/SPEECH_RECOGNITION.md`、`doc/asrapp/asr/STREAMING.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-fix-realtime-websocket-and-transcribe-layout.md)

## [2026-06-20] 修复录音识别并增加麦克风音频中转混音

- **类型**: fix / feat / docs
- **描述**: 修复删除说话人分离字段后，现有 SQLite `asr_tasks.diarize_enabled NOT NULL` 与 ORM 不兼容，导致录音上传在创建任务时返回 500/`Failed to fetch` 的问题；该列仅作为数据库兼容字段保留并固定写入 `false`。桌面变声器/TTS 新增共享麦克风音频中转：启用后由一个真实麦克风采集流常态透传到当前输出设备，录音和实时 ASR 复用克隆轨道，音效、普通 TTS 和流式 PCM TTS 注入同一个 Web Audio 混音总线，可统一送往 VB、BlackHole 等虚拟声卡。
- **影响范围**: `backend/app/db/`、`backend/tests/test_api.py`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/Transcribe.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/styles/global.css`、`doc/desktop/`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-fix-recording-fetch-and-audio-relay-mixer.md)

## [2026-06-20] 桌面语音识别确认、任务遥测与 X-ASR 多窗口

- **类型**: feat / fix / refactor / docs
- **描述**: 桌面“文件转写”统一改名为“语音识别”，文件选择/拖放后增加确认步骤并删除“最近任务”卡片；标点恢复由占位透传改为懒加载 FunASR CT-Punc；删除说话人分离的桌面开关、请求/响应字段、任务调用链和后端占位文件；开发调试台新增文件 ASR 与实时 VAD→ASR→TTS 任务 trace 瀑布图，覆盖 ASR 首 token、TTS 首个可播放 token/chunk、完成和播放提交；模型管理新增 160/480/960/1920 ms X-ASR 单选切换，并从 Hugging Face 下载四套官方权重。
- **影响范围**: `frontend/desktop/src/`、`backend/app/api/v1/`、`backend/app/core/pipeline/post/`、`backend/app/core/asr/engines/x_asr.py`、`backend/app/schemas/`、`backend/tests/`、`scripts/verify_x_asr_cuda.py`、`doc/desktop/`、`doc/asrapp/`
- **测试报告**: [专项测试报告](reports/2026-06-20-desktop-asr-confirm-punctuation-telemetry-xasr-variants-test-report.md)
- **Plan**: [链接到 plan 文件](plans/2026-06-20-desktop-asr-confirm-punctuation-telemetry-xasr-variants.md)

## [2026-06-20] 修复模型管理 AbortError 并跑通 X-ASR CUDA

- **类型**: fix / chore / docs
- **描述**: 修复模型管理 `/v1/models` 的 8 秒无 reason abort：刷新请求改为单一 controller，新刷新只取消旧刷新，页面卸载/替代取消不再弹错，20 秒超时显示明确后端提示，调试台把正常取消记录为 info。模型加载/卸载期间锁定全部模型操作，避免多个 GPU 模型并发加载。清理 `.env` 中 FireRed、Whisper、SenseVoice 的旧 CPU 覆盖，五个 ASR 默认设备统一为 CUDA。安装官方 `sherpa-onnx 1.13.2+cuda12.cudnn9`，补齐 CUDA/cuDNN 动态库预加载和 Miniconda libstdc++ ABI 兼容，禁止 CPU wheel 静默冒充 CUDA。RTX 5070 Ti 实测加载增加 1359 MiB 显存，6.8 秒音频产生 23 partial、1 final。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/telemetry.ts`、`backend/app/core/asr/engines/x_asr.py`、`backend/app/config.py`、`scripts/`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-fix-model-refresh-abort-and-xasr-cuda.md)

## [2026-06-20] ASR 双通路、离线热词、远程 TTS 与开发调试台

- **类型**: feat / refactor / fix / docs
- **描述**: 离线 ASR 与 X-ASR 实时流式模型改为同时配置，全部 ASR 初始设备为 CUDA；实时字幕和免按键对话统一使用 X-ASR 原生 online stream，删除录音分块调用离线识别和 final 离线精修。删除多模型合并策略及前后端字段。离线转写新增 CapsWriter 风格热词、别名/黑名单、拼音近似和正则规则动态加载。Higgs TTS 新增本地/Boson 远程切换、Token 代理与连接检查。文件转写录音栏保持同排，并新增全局开发调试台统计 HTTP、WebSocket、ASR 首字/final、TTS 首包/总耗时。
- **影响范围**: `backend/app/core/asr/`、`backend/app/core/streaming/`、`backend/app/api/v1/`、`frontend/desktop/src/`、`backend/tests/`、`doc/`
- **测试报告**: [2026-06-20 测试报告](reports/2026-06-20-asr-hotwords-remote-tts-debug-test-report.md)
- **Plan**: [链接到 plan 文件](plans/2026-06-20-asr-stream-hotwords-remote-tts-debug.md)

## [2026-06-20] 启动桌面前端开发环境

- **类型**: chore
- **描述**: 检查本地后端与 Vite 端口，启动 `frontend/desktop` 的 Vite + Electron 开发环境并验证页面连通性；不涉及业务代码变更。
- **影响范围**: `frontend/desktop` 开发进程、运行文档
- **Plan**: [链接到 plan 文件](plans/2026-06-20-open-desktop-frontend.md)

## [2026-06-20] 新增 X-ASR 真流式模型与离线/流式模式选择

- **类型**: feat / docs
- **描述**: 将 `thirdparty/X-ASR` 的 X-ASR-zh-en 160 ms Zipformer 注册为 `x-asr`，通过 sherpa-onnx 为每句话维护独立 online stream，连续 PCM 块直接产生 partial，VAD 结束后复用同一状态产出 final。模型文件已下载并校验，真实录音已产生多个 partial 和一个 final；后续双通路重构已移除 final 离线精修。
- **影响范围**: `backend/app/core/asr/`、`backend/app/core/streaming/session.py`、`backend/app/core/model_manager.py`、`backend/app/api/v1/models.py`、`backend/app/config.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/store/useASRStore.ts`、`thirdparty/X-ASR/`、`pyproject.toml`、`doc/asrapp/asr/`
- **Plan**: [链接到 plan 文件](plans/2026-06-20-x-asr-streaming-model.md)

## [2026-06-19] 变声器音色即时切换、partial 低延迟 TTS 与音效播放

- **类型**: feat / fix
- **描述**: 修复 `变声器/TTS` 页面内切换音色不生效的问题，音色下拉现在会同步写入全局 TTS 设置，文本 TTS、语音转 TTS 和实时 ASR+TTS 会立即使用当前音色。实时 ASR+TTS 不再等整句 final 才触发 TTS，首个非空 `partial` 会 speculative 启动 Higgs 流式 TTS，final 只在没有 partial TTS 时兜底；前端 PCM 采集块降到 512 frame，实时 Higgs `initial_codec_chunk_frames` 使用 0。新增音效区，支持导入多个音频并一键播放到当前输出设备或 VB 等虚拟声卡。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/app/config.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-voicechanger-voice-low-latency-sfx.md)

## [2026-06-19] 修复公网 TTS WebSocket 诊断并对齐 Higgs 流式 PCM

- **类型**: fix
- **描述**: 对比 staged/unstaged 后确认公网后端 `112.124.13.120:18000` 的 HTTP 与 `/v1/tts/higgs/stream` WebSocket 均可连通；前端 TTS WebSocket 失败提示不再固定误导为后端监听或防火墙问题，改为列出实际尝试 URL，并提示 HTTPS 页面连接 `ws://` 的 mixed content 或代理 Upgrade 问题。后端 Higgs 流式代理按 `higgs-audio/webui.py` 对齐 `stream=true`、`response_format=pcm`、32768 chunk、`x-sample-rate`、`x-channels`、`x-bit-depth` 与 16-bit 对齐。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`frontend/desktop/src/services/audio.ts`、`backend/tests/test_higgs_tts_api.py`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-fix-public-websocket-higgs-stream.md)

## [2026-06-19] 实时 ASR+TTS 增加流式首包延迟

- **类型**: feat
- **描述**: `WS /v1/tts/higgs/stream` 的实时 TTS 路径默认向 Higgs 发送 `stream=true`，后端按音频 chunk 转发 `tts_start`、`tts_chunk`、`tts_done` 事件，并保留完整 `tts` 事件兼容旧前端。桌面端实时模式新增 PCM chunk 播放器，展示 TTS 首包、端到端首包、TTS 完成和后端总计，用于验证实时 ASR+流式 TTS 是否达到 1 秒内首包目标。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`backend/tests/test_higgs_tts_api.py`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-realtime-asr-tts-latency-streaming.md)

## [2026-06-19] 修复 TTS 参考音频 Data URL 转换

- **类型**: fix
- **描述**: 修复“当前 ASR 生成并填充”仍提示 `Failed to fetch` 的问题。根因是前端在调用 ASR 前用 `fetch(dataUrl)` 把参考音频 Data URL 转 Blob，部分浏览器/Electron 环境会直接拦截 `data:` fetch。现在改为本地解析 Data URL/base64，不触发网络请求，再复用 `/v1/transcribe` 生成预填充文本。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-fix-reference-prefill-data-url-fetch.md)

## [2026-06-19] TTS 参考文本预填充改用通用 ASR

- **类型**: fix
- **描述**: `模型管理 -> TTS 模型设置` 中“当前 ASR 生成并填充”不再调用独立 `/v1/tts/higgs/reference-asr`，改为直接复用桌面端已有 `/v1/transcribe` 接口。参考音频按当前 ASR 引擎和语言转写，兼容同步结果和异步任务轮询，再把 `full_text` 填入“参考音频准确文本”框。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-use-transcribe-for-tts-reference-prefill.md)

## [2026-06-19] 统一 TTS 音色目录

- **类型**: fix / chore
- **描述**: 将旧版 `data/higgs_voice_presets.json` 中的音色迁移到统一目录 `data/tts/voices/<id>/`，当前已有 `default`、`Elysia`、`maoli` 都位于该目录。后端读取音色时会自动把旧 JSON 中尚未目录化的条目写入目录，并清空旧 JSON，接口对外只以目录音色库为准。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`data/tts/voices/`、`data/higgs_voice_presets.json`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-unify-tts-voices-directory.md)

## [2026-06-19] 修复 TTS 参考音频 ASR Failed to fetch

- **类型**: fix
- **描述**: 修复 `模型管理 -> TTS 模型设置` 中“当前 ASR 生成并填充”在 Electron/file 场景或公网 IP 前后端跨端口访问时容易出现 `Failed to fetch` 的问题。空后端地址在 `file:` / `app:` 页面下会回落到 `http://localhost:8000`；后端 CORS 正则新增公网 IPv4 来源支持；参考音频 ASR 请求失败时会显示实际请求地址和配置建议。
- **影响范围**: `frontend/desktop/src/services/api.ts`、`backend/app/main.py`、`backend/tests/test_cors.py`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-fix-tts-reference-asr-failed-fetch.md)

## [2026-06-19] TTS 参考音频支持录音与 ASR 填充

- **类型**: feat
- **描述**: 桌面端 `模型管理 -> TTS 模型设置 -> 上传 / 保存音色` 中，参考音频除了上传文件外新增录音输入；停止录音后自动写入参考音频并可直接播放检查。“当前 ASR 生成并填充”按钮会调用现有 `/v1/tts/higgs/reference-asr`，把当前参考音频识别结果直接填入“参考音频准确文本”框。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-tts-reference-audio-recording-asr-fill.md)

## [2026-06-19] 补齐 TTS/ASR 模型管理残留

- **类型**: fix / docs
- **描述**: 将 TTS 上传弹窗文案进一步收窄为“上传 / 保存音色”，保留常用音色、句首控制标签和生成参数在外层；变声器的一句话“语音转 TTS”改为前端录完整音频后走 `/v1/tts/higgs/audio-to-speech`，避免 WebSocket VAD final 时序导致不可用；变声器刷新运行环境时同步后端已保存音色，便于临时切换；源码层面删除未注册的 Vosk、Sherpa 和 Stream stub ASR 引擎文件。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`backend/app/core/asr/engines/`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-19-tts-asr-model-management-completion.md)

## [2026-06-18] 优化 TTS 与 ASR 模型管理

- **类型**: feat / fix
- **描述**: 重构桌面端 TTS 模型设置，将当前音色、句首控制标签和生成参数移出弹窗，弹窗聚焦上传/保存音色；音色改为保存到 `data/tts/voices/<id>/` 并支持参考音频播放和当前 ASR 自动生成参考文本；修复语音转 TTS 停止录音时过早关闭 WebSocket 导致收不到 TTS 的问题；实时 ASR+TTS 改用更小 PCM 块和二进制 WebSocket 帧降低前端传输延迟，并保留输出设备选择；变声器/TTS 增加本次使用音色选择；前后端移除 Vosk、Sherpa、Stream 入口；ASR 模型管理支持展开子模型配置启动设备和参数；后端地址支持 `112.124.13.120:18000` 这类无协议公网地址；前端移除事件检测入口。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/app/api/v1/models.py`、`backend/app/core/asr/registry.py`、`backend/app/core/model_manager.py`、`backend/app/config.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/App.tsx`、`frontend/desktop/src/components/Sidebar.tsx`、`frontend/desktop/src/components/Toolbar.tsx`、`frontend/desktop/src/styles/global.css`、`backend/tests/test_higgs_tts_api.py`、`backend/tests/test_engines.py`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-tts-asr-model-management-optimization.md)

## [2026-06-18] 整理非核心文件到 tmp

- **类型**: chore / docs
- **描述**: 新增项目本地 `tmp/` 归档目录并加入 `.gitignore`，将旧版散落文档、外层总仓归档、文档站生成/缓存产物、根目录样例音频和 Python 构建/缓存产物移入 `tmp/`；同时清理文档站导航与旧链接，保留被 `CHANGELOG` 引用的任务 plan 到 `doc/plans/`。
- **影响范围**: `.gitignore`、`tmp/`、`doc/README.md`、`doc/index.md`、`doc/.vitepress/config.mts`、`doc/asrapp/`、`doc/desktop/README.md`、`doc/plans/`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-project-tmp-cleanup.md)

## [2026-06-18] 配置 VS Code preview 文件打开行为

- **类型**: chore / docs
- **描述**: 新增工作区级 VS Code 设置，让资源管理器单击文件时使用 preview 临时标签，继续单击其他文件会复用该标签，双击文件后固定为常规标签页。
- **影响范围**: `.vscode/settings.json`、`doc/development/README.md`、`doc/README.md`、`doc/.vitepress/config.mts`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-vscode-preview-open-mode.md)

## [2026-06-18] 合并外层 doc 到 asrapp 项目文档

- **类型**: docs
- **描述**: 将 `/home/yami/AI/doc` 合并迁入 `/home/yami/AI/asrapp/doc`。因目标目录已有近期 asrapp 文档、TTS 说明和多个 plan，本次采用合并而非替换：保留现有 `README.md`、`CHANGELOG.md`、桌面端文档和近期计划；迁入外层 VitePress 配置、`asrapp/` 完整文档树、历史 plan、文档站 package 文件，并将外层总仓 README/CHANGELOG 归档到 `doc/archive/root-doc/`。
- **影响范围**: `doc/`、`doc/.vitepress/config.mts`、`doc/asrapp/`、`doc/archive/root-doc/`、`doc/plans/`、`.gitignore`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-merge-root-doc-into-asrapp.md)

## [2026-06-18] TTS 设置弹窗化并新增后端音色库

- **类型**: feat
- **描述**: 桌面端 `模型管理 → TTS 模型设置` 改为紧凑摘要 + 弹窗配置，避免所有 Higgs 参数默认全展开。弹窗支持输入音色名、上传参考音频、填写参考音频链接、准确文本和 Code JSON，并调用后端永久保存本地音色 preset。后端新增本地 Higgs 音色库，`voices` 会合并远端音色和本地保存音色；TTS 请求只传保存过的音色名时，也会自动套用后端保存的参考音频/文本/Code JSON。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/task-plan-20260618-224101-tts-voice-library.md)

## [2026-06-18] 补全 Higgs TTS 音色与控制参数

- **类型**: feat
- **描述**: 对照 `/home/yami/AI/audio/TTS/higgs-audio/webui.py` 补全桌面端 `模型管理 → TTS 模型设置`：新增参考音频 Data URL、参考音频 URL、参考文本、`reference_codes`、句首情绪/风格/韵律控制标签、`aac` 输出格式和流式首个 codec chunk 帧数。后端 Higgs proxy 现在按 webui 的 payload 规则生成 `references` / `reference_codes` 和控制标签，并让文本 TTS、上传音频 ASR→TTS、实时 ASR+TTS 共用这些持久化设置。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`backend/tests/test_higgs_tts_api.py`、`frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-complete-higgs-tts-model-settings.md)

## [2026-06-18] 修复实时 ASR+TTS 输出音频触发自动停止

- **类型**: fix
- **描述**: 修复实时 ASR+TTS 在一句话 VAD 结束并生成 TTS 后自动中断的问题。根因是 `VoiceChangerPage` 的 URL 清理 effect 依赖 `outputAudioUrl`，每次 TTS 返回音频并更新 URL 时都会执行 cleanup，从而调用 `streamClientRef.current?.stop()` 主动关闭 WebSocket。现在 WebSocket 只在组件卸载或用户手动停止时关闭，实时模式会持续监听并对每一句 final ASR 结果执行 TTS。
- **影响范围**: `frontend/desktop/src/pages/VoiceChanger.tsx`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-fix-realtime-tts-url-cleanup-stop.md)

## [2026-06-18] 桌面端 TTS 模型设置迁移与实时 TTS 修复

- **类型**: feat / fix
- **描述**: 在桌面端模型管理新增 `TTS 模型设置`，集中配置 Higgs API 地址、音色、输出格式和生成参数；变声器/TTS 页面移除模型地址与音色配置入口，仅保留工作台操作和输出设备。实时 ASR+TTS 的 WebSocket 关闭事件现在区分主动停止与异常断开，收到一句话 TTS 后保持实时监听。
- **影响范围**: `frontend/desktop/src/pages/Models.tsx`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`、`doc/desktop/README.md`、`doc/desktop/TTS_VOICE.md`
- **Plan**: [链接到 plan 文件](plans/2026-06-18-desktop-tts-model-settings-realtime.md)

## [2026-06-18] 修复变声器 WebSocket 连接失败 + ASR CPU 模式

- **类型**: fix
- **描述**: 修复前端变声器 WebSocket connection failed 问题。根因：① ASR 引擎默认配置为 GPU (cuda/cuda:0)，GPU 显存已满 (11.3GB/16GB)，导致模型加载时 OOM；② 前端 WebSocket 客户端错误信息不足，且缺少 URL 校验与连接超时检测。修复后将 SenseVoice Small 和 FireRedASR2 改为 CPU 模式，streaming 的 partial/final ASR 统一使用 sensevoice，同时强化前端 WebSocket 客户端的错误诊断能力。
- **影响范围**: `backend/.env`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/pages/VoiceChanger.tsx`
- **Plan**: [链接](plans/2025-06-18-fix-websocket-cpu-asr.md)

### 变更详情
- `backend/.env`:
  - `DEFAULT_ENGINE`: `fireredasr2` → `sensevoice`
  - 新增 `default_sensevoice_device=cpu`
  - 新增 `default_stream_final_engine=sensevoice`
  - `DEFAULT_FIREREDASR2_DEVICE`: `cuda` → `cpu`
  - `DEFAULT_WHISPER_DEVICE`: `cuda` → `cpu`
- `frontend/desktop/src/services/audio.ts`:
  - `StreamingASRClient` / `VoiceTTSStreamingClient`:
  - 新增 `new URL()` 校验，无效地址提前报错
  - `onerror` 消息现包含实际 URL
  - 新增 5s 连接超时检测
  - fallback `final_engine`: `'fireredasr2'` → `'sensevoice'`
- `frontend/desktop/src/store/useASRStore.ts`:
  - `defaultEngine`: `'fireredasr2'` → `'sensevoice'`
  - `selectedEngines`: `['fireredasr2']` → `['sensevoice']`
  - `normalizeSettings()` 新增强健性：空 URL/无协议前缀 URL 自动重置为默认值，去除末尾斜杠；早期曾把过期远程地址迁移到本地默认地址，该行为已在后续公网测试支持中取消
- `frontend/desktop/vite.config.ts`:
  - 新增 Vite proxy — `/v1` 转发到 `http://localhost:8000`（含 WebSocket），绕过 WSL2 localhost 转发问题
- `frontend/desktop/src/pages/VoiceChanger.tsx`:
  - 组件挂载时 `console.log` 输出版本和服务 URL，方便诊断

## [2026-06-17] 桌面端 Higgs TTS 与变声器工作台

- **类型**: feat
- **描述**: 新增桌面端变声器/TTS 工作台，支持 Higgs v3 文本 TTS、后端 VAD→ASR→TTS 组合 WebSocket、上传音频 ASR→TTS、实时 ASR→TTS、环节延迟展示和音频输出设备选择。
- **影响范围**: `backend/app/api/v1/tts_api.py`、`frontend/desktop/src/pages/VoiceChanger.tsx`、`frontend/desktop/src/services/api.ts`、`frontend/desktop/src/services/audio.ts`、`frontend/desktop/src/store/useASRStore.ts`、`frontend/desktop/src/styles/global.css`、`frontend/desktop/src/components/Sidebar.tsx`、`backend/tests/test_higgs_tts_api.py`、`scripts/verify_higgs_tts_e2e.py`
- **Plan**: [链接到 plan 文件](plans/2026-06-17-desktop-higgs-tts-voice-changer.md)
