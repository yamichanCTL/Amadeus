# 修复实时识别 WebSocket 并重排语音识别页面

> **父文档**: [← 返回文档索引](../README.md)
> **相关文档**: [桌面语音识别](../desktop/SPEECH_RECOGNITION.md) · [实时流式识别](../asrapp/asr/STREAMING.md)

## 任务目标

- 修复实时识别连接 `ws://your-server-ip:18000/v1/stream` 失败后直接终止的问题。
- 恢复当前无响应的 ASR 后端，并验证 `/v1/health` 与 `/v1/stream`。
- 参考本次 ImageGen 生成的布局，将“识别预览”从右侧栏移动到“语音识别”上传区下方，页面改为从上到下的宽卡片布局。

## 影响范围分析

- `frontend/desktop/src/services/audio.ts`
  - 实时 ASR WebSocket 从单地址直连改为候选地址顺序连接：配置后端地址优先，同源 `/v1` 代理兜底。
  - 只有全部候选地址失败后才报告错误，并列出实际尝试地址和更准确的诊断建议。
- `frontend/desktop/src/pages/Transcribe.tsx`
  - 将预览卡片移动到上传卡片之后；识别设置与助手区域保留下移。
- `frontend/desktop/src/styles/global.css`
  - 语音识别主布局改为单列宽卡片；预览内容、操作按钮和播放器适配横向空间。
- 运行进程
  - 清理本次调试遗留的 pytest 进程；重启只有监听父进程、工作子进程已成为 zombie 的 Uvicorn 后端。
- 文档与变更记录
  - 更新 WebSocket 回退策略、页面结构、CHANGELOG 和验证结果。

## 已确认根因

- 当前公网 `your-server-ip:18000` 和本机 `127.0.0.1:8000` 的 HTTP/WS 都超时，不是只有浏览器 WebSocket 被防火墙拦截。
- Uvicorn 仍占用 `0.0.0.0:8000`，但工作子进程已成为 zombie，只剩 reload 监听父进程，连接进入 backlog 后无人处理。
- 前端 `StreamingASRClient` 只尝试显式公网地址，且错误文案固定归因于后端/防火墙；它没有复用实时 TTS 已有的同源代理候选策略。

## 实现步骤

1. 清理本轮遗留 pytest 和失效 Uvicorn 进程，以无 reload 模式重新启动后端，避免 GPU/模型进程在热重载时再次成为 zombie。
2. 将实时 ASR 客户端改为候选 URL 顺序握手，隔离候选连接的 `error/close`，防止第一次失败提前触发页面错误。
3. 用健康的本机 WebSocket 验证 `ready`、配置消息和主动结束；公网地址恢复后再验证公网握手。
4. 按 ImageGen 参考将预览移动到上传区下方，识别设置改为下方紧凑横向卡片，保持底部录音 dock。
5. 执行 TypeScript、Vite、后端编译、VitePress 和 diff 检查。
6. 更新 CHANGELOG 与桌面/流式识别文档。

## 风险评估

- 同源代理回退只有在前端服务器配置 `/v1` WebSocket proxy 时有效；Electron/file 场景仍依赖显式后端地址。
- 公网端口当前整体超时；本地修复可以验证协议和前端回退，但公网端口映射/安全组的最终状态仍取决于部署环境。
- 关闭 Uvicorn `--reload` 后，后续代码修改需要显式重启服务，但可以避免大型模型与热重载子进程的生命周期冲突。
- 页面单列会增加纵向长度；底部 dock 保持可见，预览和设置卡片需要控制最小高度。

## 验证结果

- 修复前：公网 `18000` 与本机 `8000` 的 HTTP/WS 都超时；Uvicorn 工作进程为 zombie，监听 socket 仍由 reload 父进程持有。
- 清理失效进程并以无 reload 模式启动后，`GET /v1/health` 返回 200。
- session 初始化移出事件循环后，本机 `ws://127.0.0.1:8000/v1/stream` 在 0.014 秒完成握手并收到 `ready`。
- Vite 同源代理 `ws://127.0.0.1:5173/v1/stream` 在 0.016 秒完成握手并收到 `ready`。
- 公网 `ws://your-server-ip:18000/v1/stream` 在 0.119 秒完成握手并收到 `ready`，公网 health 返回 200。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit`：通过。
- `node node_modules/vite/bin/vite.js build`：通过，75 modules transformed。
- `.venv/bin/python -m compileall -q backend/app`：通过。
- `doc/npm run build`：通过。
- `git diff --check`：通过。

最终为加载断连清理补丁而正常停止了验证进程；再次启动命令因执行环境的审批用量限制被拒绝，不是代码或服务启动错误。交付后需手动执行无 reload 启动命令。
