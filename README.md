<p align="center">
  <img src="img/Amadeus/amadeus-icon.png" width="112" alt="Amadeus icon" />
</p>

<h1 align="center">Amadeus</h1>

<p align="center">
  本地优先的语音工作台：离线与流式 ASR、跨应用语音输入、实时 Agent、TTS/变声和会话总结。
</p>

<p align="center">
  <a href="doc/asrapp/installation/README.md">安装</a> ·
  <a href="doc/desktop/README.md">桌面端</a> ·
  <a href="doc/asrapp/backend/README.md">后端</a> ·
  <a href="doc/README.md">完整文档</a> ·
  <a href="doc/CHANGELOG.md">变更日志</a>
</p>

## Instruction

语音识别、文本增强和语音输出放在一条可观测的本地链路中。桌面端负责录音、快捷键、浮层和跨应用输入；FastAPI 后端负责模型生命周期、离线/流式识别、LLM 后处理、Agent 和 TTS 代理。敏感配置与归档默认留在本机。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 离线与流式 ASR | FireRedASR2、SenseVoice、Qwen3-ASR、Whisper 与 X-ASR，可在模型管理中加载、卸载和切换 |
| 跨应用语音输入 | 全局快捷键、录音状态浮层、取消/提交控制，以及 Windows 文本注入与剪贴板回退 |
| 润色/翻译 | 同一套 OpenAI 兼容模型配置，通过 Prompt 完成纠错、改写或翻译；增强结果可自动回填 |
| 实时字幕与 Agent | WebSocket 流式识别、桌面字幕、连续语音 Agent、本地工具和任务委派 |
| TTS 与变声 | Higgs Audio 本地/远程代理、参考音色、实时 ASR→TTS、输出设备和虚拟声卡路由 |
| 历史与总结 | 本地音频/JSON 归档、筛选与导出、主动/被动当日总结 |
| 可观测性 | HTTP、WebSocket、ASR、LLM 和 TTS 阶段耗时与调试事件 |

## 快速开始

### 环境要求

- Python 3.10–3.14 与 [uv](https://docs.astral.sh/uv/)
- Node.js 20+
- FFmpeg
- 可选：NVIDIA CUDA（GPU 模型）

模型、CUDA 和第三方源码的详细组合见[环境安装与迁移](doc/asrapp/installation/README.md)。

### 1. 启动后端

```bash
cp backend/.env.example backend/.env
uv sync --all-extras
cd backend
uv run --no-sync uvicorn app.main:app --host 127.0.0.1 --port 8000
```

服务启动后：

- 健康检查：`http://127.0.0.1:8000/v1/health`
- OpenAPI：`http://127.0.0.1:8000/docs`

### 2. 启动桌面端

```bash
cd frontend/desktop
npm install
npm run dev
```

首次进入“设置”后填写并确认后端地址 `http://127.0.0.1:8000`，再到“模型管理”加载所需 ASR 模型。

### 3. 可选：连接 Higgs TTS

Amadeus 后端通过 `/v1/tts/higgs/*` 代理本地或远程 Higgs 服务。服务启动方式、端口和参考音色配置见 [Higgs TTS 与变声器](doc/desktop/TTS_VOICE.md)。

## 工作方式

```text
麦克风 / 文件 / 扬声器
          │
          ▼
Electron 桌面端 ── HTTP / WebSocket ── FastAPI 后端
     │                                  │
     │                                  ├─ ASR 模型管理与推理
     │                                  ├─ 润色/翻译与 Agent
     │                                  ├─ Higgs / GPT-SoVITS / VoxCPM
     │                                  └─ 任务、归档与遥测
     │
     ├─ 状态/字幕浮层
     ├─ 跨应用文本注入
     └─ 音频输出与虚拟声卡
```

主要目录：

```text
backend/app/              FastAPI API、ASR/LLM/TTS 核心与任务
frontend/desktop/         Electron + React + TypeScript 桌面端
frontend/android/         Android 客户端
runner/                   本地模型运行器
scripts/                  启动、诊断、压力和端到端验证脚本
doc/                      VitePress 文档、设计计划与测试报告
```

## 验证

```bash
# 后端业务测试
.venv/bin/python -m pytest backend/tests -q

# 桌面端单测、类型和前端构建
cd frontend/desktop
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit
node node_modules/vite/bin/vite.js build

# 文档路由与链接
cd ../../doc
npm run build
```

硬件相关验证不会与协议级验证混为一谈。真实麦克风、Windows UIAutomation、CUDA 模型和 TTS 服务的测试范围与结果记录在 [`doc/reports/`](doc/reports/)；桌面端专项验证脚本位于 [`scripts/`](scripts/)。

## 打包

```bash
cd frontend/desktop
npm run build:win      # Windows NSIS
npm run build:linux    # Linux AppImage
```

Windows 任务栏、主窗口和安装包统一使用 `img/Amadeus/amadeus-icon.png`。

## 文档导航

- [安装与环境迁移](doc/asrapp/installation/README.md)
- [桌面端总览](doc/desktop/README.md)
- [语音识别](doc/desktop/SPEECH_RECOGNITION.md)
- [输入、浮层与跨应用注入](doc/desktop/INPUT_AND_OVERLAYS.md)
- [模型管理](doc/desktop/MODEL_MANAGEMENT.md)
- [TTS 与变声器](doc/desktop/TTS_VOICE.md)
- [后端架构](doc/asrapp/backend/README.md)
- [API 文档](doc/asrapp/backend/API.md)

## 当前边界

- 模型权重、外部源码和机器专属 CUDA 路径不进入仓库；通过 `backend/.env` 或模型管理配置。
- Windows 跨应用输入依赖 UIAutomation；失败时保留剪贴板和结果浮层，不丢失识别文本。
- 各模型的显存、驱动和运行时要求不同，安装前应先阅读对应模型文档。
