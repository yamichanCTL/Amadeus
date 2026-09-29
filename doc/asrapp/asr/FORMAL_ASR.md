# FormalASR：中文语音直接转书面文本

Amadeus 的离线语音输入支持 `TaurenMountain/FormalASR-1.7B`，引擎 ID 为 `formalasr`。
模型基于 Qwen3-ASR 微调，通过同一次推理完成识别与口语整理，不需要 API Key 或额外的文本 LLM。

## Windows 安装

在项目根目录、已有后端 `.venv` 环境中运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install_formalasr.ps1
```

脚本使用 CUDA 12.8 PyTorch（支持 RTX 50 系列）、安装 `.[formalasr]` 可选依赖，
并下载约 4.08 GB 的公开模型权重。下载目录 `backend/models/FormalASR-1.7B` 已被 Git 忽略。
下载失败后可以重跑继续下载。已有合适 PyTorch 时，也可以只执行：

```powershell
uv pip install --python .venv/Scripts/python.exe -e '.[formalasr]'
.venv/Scripts/python.exe scripts/download_formalasr.py
```

CPU 安装可添加 `-CpuOnly`；模型管理中同时设 `device=cpu`、`compute_type=float32`。
CPU 速度需要在实际设备上评估。模型文件大小不等于运行显存。

## 在桌面客户端使用

1. 更新桌面构建并重启后端。
2. 在「模型管理」找到 **FormalASR · 中文口语整理**，点击加载，设为离线模型。
3. 默认模型 `TaurenMountain/FormalASR-1.7B`，设备 `cuda:0`，精度 `bfloat16`。
4. 在录音/文件识别页面体验。要比较 FormalASR 自身的效果，点击提示中的「关闭追加 LLM 处理」。

模型切换不会自动覆盖原有的 LLM 润色、翻译开关。保持追加处理开启时，仍会按用户配置调用相应服务。
FormalASR 已输出标点，后端会跳过额外标点模型，避免再次改变结果。

## 配置及 HTTP 接口

可选环境变量见 `backend/.env.example` 中 FormalASR 段。
模型管理的额外 JSON 支持 `model_dir`（自定义本地目录）和 `max_new_tokens`（默认 1024）。

```http
POST /v1/models/formalasr/load
Content-Type: application/json

{"model_name":"TaurenMountain/FormalASR-1.7B","device":"cuda:0","compute_type":"bfloat16"}
```

使用现有 `/v1/transcribe` multipart 上传接口，`options` 为：

```json
{
  "engine": "formalasr",
  "language": "zh",
  "timeout_sec": 180,
  "enable_punctuation": false,
  "enable_hotwords": false,
  "allow_server_data_collection": false
}
```

省略 `llm` 即不调用额外文本模型。首次加载请通过模型管理完成，避免冷启动占用录音请求的超时预算。
本地接口冒烟测试（会实际加载模型，并对同一录音识别两次）：

```powershell
.venv/Scripts/python.exe scripts/smoke_formalasr.py your_chinese_audio.wav --report .runtime/formalasr-smoke.json
```

## 已知边界

- 仅接入中文书面化识别；不是全双工语音对话模型，不负责语音播报。
- 本适配器在完成录音后返回结果，不提供保持解码状态的逐字流式识别。
- 整理后的文字可能省略、合并口语词句，因此不返回虚构的逐词时间戳。
- 当前长录音沿用 Amadeus 的 60 秒独立分块及 Celery 后台任务；跨块改口可能丢失上下文。
- 不将热词当作任意改写提示词注入模型。数字、人名、否定和中途改口的准确性需要实际录音评测。
- 2026-09-29 补测中，4 条合成改口/撤回样例均保留了被纠正内容；加入明确编辑指令仍未解决。
  当前版本不能作为可靠的语义改口编辑器，详见 `doc/reports/2026-09-29-formalasr-integration.md`。

参考：[作者代码](https://github.com/TaurenMountain/FormalASR)、
[1.7B 模型权重与许可证](https://huggingface.co/TaurenMountain/FormalASR-1.7B)。
