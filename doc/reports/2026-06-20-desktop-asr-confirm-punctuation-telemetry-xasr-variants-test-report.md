# 桌面语音识别、标点、遥测与 X-ASR 多窗口测试报告

> **父文档**: [← 返回变更日志](../CHANGELOG.md)
> **相关文档**: [桌面语音识别](../desktop/SPEECH_RECOGNITION.md) · [X-ASR](../asrapp/asr/X_ASR.md)

## 结论

7 项需求的代码、契约、前端生产构建和 X-ASR 四窗口真实 CPU 音频解码均已验证。唯一没有完成实机闭环的是 FunASR CT-Punc 首次权重下载：当前环境的外部执行额度拒绝该下载，因此标点恢复完成了实现与模型边界单元测试，但不能在本报告中声称真实 CT-Punc 权重已跑通。

## 分项结果

| # | 需求 | 结果 | 证据 |
|---|------|------|------|
| 1 | 改名并增加文件确认 | 通过 | 侧栏和页面均为“语音识别”；拖放只写入 `pendingFiles`，仅“确认并开始识别”调用识别；TypeScript 与 Vite 构建通过。 |
| 2 | 删除最近任务 | 通过 | 桌面源码无“最近任务”，历史记录页保留；静态清理断言通过。 |
| 3 | 修复标点恢复 | 代码与单测通过；真实权重待补 | 占位透传已替换为 FunASR `ct-punc` 懒加载/复用/线程推理；正常输出、空输入、无效输出测试通过。首次真实模型下载被环境额度拒绝。 |
| 4 | 任务级延时可视化 | 通过 | trace 覆盖文件 ASR 确认→上传→后端阶段→展示，以及实时 VAD→ASR 首 token/final→TTS 首可播放 token/chunk→完成；调试台瀑布图、P95、筛选和 JSON 导出通过类型检查与生产构建。 |
| 5 | 删除说话人分离 | 通过 | UI、请求/响应 schema、任务管线、占位模块和 segment/export speaker 逻辑已删除；旧 Zustand 字段只保留一次性迁移清理。 |
| 6 | X-ASR 多窗口选择与下载 | 通过（CPU 实机） | 160/480/960/1920 ms 官方 ONNX 文件均从 Hugging Face 下载；模型设置单选；33 项定向测试包含四窗口解析/本地可用性；四套实际音频 decode 均有 partial/final。 |
| 7 | 逐项验证和报告 | 通过 | 本报告、Plan、CHANGELOG、桌面/ASR/API 文档和 VitePress 构建均已完成。 |

## 自动化验证

```bash
cd /home/yami/AI/asrapp

# 后端定向测试
timeout 90s .venv/bin/pytest -q \
  backend/tests/test_pipeline.py \
  backend/tests/test_x_asr.py \
  backend/tests/test_streaming_session.py \
  backend/tests/test_higgs_tts_api.py
# 33 passed

# Python 静态编译
.venv/bin/python -m compileall -q backend/app scripts

# 桌面类型检查和生产构建
cd frontend/desktop
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit
node node_modules/vite/bin/vite.js build

# 文档路由构建
cd ../../doc
npm run build
```

上述命令全部退出 0。额外静态断言确认：确认按钮唯一存在、活动源码无最近任务/说话人分离入口、四个 encoder 均为大于 500 MiB 的真实 ONNX 文件。

## X-ASR 四窗口实际音频结果

测试音频：`data/archive/yami/2026-06-04/实时转写/2026-06-04_00-02-49_qwen3asr_691252.wav`，取前 6.8 秒，16 kHz online stream。

| 窗口 | partial 数 | final 数 | CPU 总耗时 |
|------|-----------:|---------:|-----------:|
| 160 ms | 23 | 1 | 2.706 s |
| 480 ms | 12 | 1 | 1.938 s |
| 960 ms | 6 | 1 | 1.717 s |
| 1920 ms | 3 | 1 | 1.755 s |

四套均使用 `sherpa-onnx 1.13.2+cuda12.cudnn9` 的 CPU provider 完成真实解码。尝试 CUDA 时当前容器返回“GPU access blocked by the operating system / CUDA driver version is insufficient”，因此本轮不把 CUDA 计为通过或失败；这是运行隔离限制，不是模型文件验证结果。

## 标点权重限制

代码默认模型为 FunASR `ct-punc`。首次真实中文调用需要下载权重；当前会话的外部执行审批因额度耗尽被拒绝，且本地缓存没有该模型。本轮验证覆盖了实际异步调用边界和模型结果解析，但未覆盖真实权重推理。环境恢复后执行：

```bash
cd /home/yami/AI/asrapp
.venv/bin/python -c "import asyncio; from backend.app.core.pipeline.post.punctuation import restore_punctuation; print(asyncio.run(restore_punctuation('你好世界今天天气怎么样', 'zh')))"
```

只有该命令输出带标点文本后，才能把标点项的“真实权重待补”改为完全实机通过。

---

> 📖 [返回变更日志 →](../CHANGELOG.md)
