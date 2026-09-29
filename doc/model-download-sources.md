# 本地 ASR 模型下载来源核验

核验日期：2026-09-29。目录定义在 `backend/app/core/model_catalog.json`。

本次核验了作者文档、官方仓库文件清单、文件大小与校验值，并实际读取了小型配置文件。没有重新下载或推理全部大模型。目录中的 `estimated_size_bytes` 来自选中的 Hugging Face 文件清单，包含少量配置与说明文件；不同站点的 README 可能造成小幅差异。

## 模型与格式

| 模型 | 兼容当前适配器的格式 | 核验来源 | 选中文件约大小 |
| --- | --- | --- | --- |
| SenseVoiceSmall | FunASR / PyTorch，`model.pt` | [官方 ModelScope](https://modelscope.cn/models/iic/SenseVoiceSmall)、[官方 HF](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) | 937 MB |
| FireRedASR2-AED | FireRedASR2S AED，`model.pth.tar` | [作者指定 ModelScope](https://modelscope.cn/models/xukaituo/FireRedASR2-AED)、[官方 HF](https://huggingface.co/FireRedTeam/FireRedASR2-AED) | 4.73 GB |
| Qwen3-ASR-1.7B | `qwen-asr`，两片 safetensors | [官方 ModelScope](https://modelscope.cn/models/Qwen/Qwen3-ASR-1.7B)、[官方 HF](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) | 4.70 GB |
| FormalASR-1.7B | `qwen-asr`，单文件 safetensors | [作者 ModelScope](https://modelscope.cn/models/TaurenMountain/FormalASR-1.7B)、[作者 HF](https://huggingface.co/TaurenMountain/FormalASR-1.7B) | 4.09 GB |
| Whisper tiny / base | SYSTRAN 提供的 CTranslate2，`model.bin` | [tiny](https://huggingface.co/Systran/faster-whisper-tiny)、[base](https://huggingface.co/Systran/faster-whisper-base) | 78 / 148 MB |
| X-ASR 160 / 480 / 960 / 1920 ms | sherpa-onnx，三份 ONNX 与 `tokens.txt` | [作者 HF](https://huggingface.co/GilgameshWind/X-ASR-zh-en)、[作者 GitHub](https://github.com/Gilgamesh-J/X-ASR)、[作者 ModelScope 国际站](https://www.modelscope.ai/Gilgamesh-J/X-ASR-zh-en) | 每个版本约 615 MB |

大小采用十进制 MB / GB；内存、显存与运行依赖占用另计。tiny 是小体积下载及 CPU 验证对象，不代表中文识别质量推荐。

### 格式选择依据

- [Qwen 官方说明](https://github.com/QwenLM/Qwen3-ASR#released-models-description-and-download)明确提供上述 HF 与国内 ModelScope 仓库。当前适配器使用 `qwen-asr`，因此保留原仓库，未切换到后续发布的 `Qwen3-ASR-1.7B-hf` 原生 Transformers 变体，也没有附带下载 ForcedAligner。
- [FormalASR 作者模型卡](https://huggingface.co/TaurenMountain/FormalASR-1.7B)同时给出 HF 与同名 ModelScope 的加载方法；它使用 `qwen-asr`。当前适配器输出中文书面文本，关闭逐字对齐。
- [faster-whisper 官方项目](https://github.com/SYSTRAN/faster-whisper)使用 CTranslate2 模型。目录选择其维护方 SYSTRAN 的转换权重，不能拿 `openai/whisper-*` 原始 PyTorch 文件直接放入同一目录。
- [X-ASR 作者部署资料](https://github.com/Gilgamesh-J/X-ASR/tree/main/X-ASR-zh-en/deployment)要求 encoder、decoder、joiner 和 tokens 来自同一块长版本。下载白名单只包含这四个文件，避免把训练 checkpoint、其他块长、视频和 macOS 安装包一并下载。

## 官方与第三方来源

1. **ModelScope 国内官方仓库**：SenseVoice、FireRed、Qwen、FormalASR 的仓库均由各自作者资料直接指向，不以账号名字相似作为官方判据。尤其 FireRed 的国内账号是 `xukaituo`，其链接明确出现在 [FireRed 官方 README](https://github.com/FireRedTeam/FireRedASR2S#quick-start)。
2. **ModelScope 国际站**：X-ASR 作者链接是 `www.modelscope.ai`。本次国际站清单与固定版本文件请求成功；同仓库的 `modelscope.cn` 接口对 `main`、`master` 均返回 404。因此目录明确标注“国际站”，并设置独立 API / 下载域名，不能声称它是已验证的国内站镜像。
3. **Hugging Face 官方仓库**：选中清单固定到本次核验的 40 位提交号。下载会依据该版本的 LFS SHA-256 或 Git blob SHA-1 验证内容。
4. **HF-Mirror 第三方镜像**：该服务的 [公开站点](https://hf-mirror.com/)是下载加速入口，并非模型作者或 Hugging Face 官方运营来源。目录中 `official=false`，名称明确写“第三方镜像”。为避免国内访问 HF API 受阻时镜像也无法使用，随目录附带直接从官方 HF HTTPS API 核验过的 `snapshot`：提交号、路径、大小和逐文件校验值。镜像内容必须匹配这一清单，不能用镜像自己提供的校验值证明其与官方一致。
5. **GitHub 官方文件**：X-ASR 来自 `Gilgamesh-J/X-ASR` 的固定提交 `838297cd47fed858e6cf72eaf5a52f948a3edd73`。三个 ONNX 的 SHA-256 和大小读取自该提交的 Git LFS pointer；实际 URL 使用 `media.githubusercontent.com` 获取权重内容，不能把 133–134 字节的 LFS pointer 当作 ONNX。tokens 使用固定提交 raw URL，并独立计算 SHA-256。目录记录直链，无需 Git、Git LFS 或解压归档。

## HTTP 与校验实测

### Hugging Face

官方清单接口：

```text
GET https://huggingface.co/api/models/{repo}?blobs=true
```

已核验 SenseVoice、FireRed、Qwen、FormalASR、Whisper tiny/base、X-ASR 七个仓库，均返回 HTTP 200。每个文件包含 `rfilename`、`size`、`blobId`；LFS 文件额外包含 `lfs.sha256`。目录中的十个可选型号来自这七个仓库。

`hf-mirror.com/Systran/faster-whisper-tiny/resolve/d90ca5fe260221311c53c58e660288d3deb8d356/config.json` 实际读取 2249 字节，按 Git blob 规则计算 SHA-1 后与官方清单一致。此次仅验证该小文件，完整模型校验应由下载任务完成。

### ModelScope

```text
GET https://modelscope.cn/api/v1/models/{repo}/repo/files?Revision=master&Recursive=true
GET https://modelscope.cn/models/{repo}/resolve/{file.Revision}/{file.Path}
```

返回结构为 `Data.Files[]`，关键字段：`Path`、`Type`、`Size`、`Sha256`、`Revision`。只处理 `Type=blob`。`Revision` 是该文件最后变更的提交号；不能假定 `LatestCommitter.Id` 有值，本次它为空。一次冻结清单后，每个文件使用自己的 40 位 `Revision` 下载，避免下载期间分支发生更新而混合版本。

对四个国内官方仓库分别实际读取固定版本的小文件：SenseVoice 的 `configuration.json`、FireRed 的 `cmvn.ark`、Qwen 与 FormalASR 的 `config.json`，SHA-256 均匹配清单。X-ASR 使用相同协议但将域名换为 `www.modelscope.ai`；实际读取 960 ms 的 `tokens.txt`，58806 字节，SHA-256 匹配。

### GitHub

X-ASR 960 ms encoder 的固定提交 media URL 支持 Range；实际请求 `bytes=0-31` 返回 HTTP 206，`Content-Range` 指向完整大小 592966960 字节。本次只读 32 字节，没有下载整个 encoder。四个版本的 LFS pointer 已逐一核验，其权重 SHA-256 与官方 HF 清单一致。

## 安装目录与运行条件

`directory` 是默认的 `MODELS_DIR` 相对目录。已有显式配置时，应遵循现有 Settings 路径助手，不把模型写到与加载器不同的地方：

| 引擎 | 路径解析 |
| --- | --- |
| sensevoice | `sensevoice_model_path()` / `sensevoice_model_dir` |
| fireredasr2 | `fireredasr2_model_path(model_name)` |
| qwen3asr | `qwen3asr_model_path(model_name)` |
| formalasr | `formalasr_model_path(model_name)` |
| whisper | `whisper_model_path(model_name)`，如 `MODELS_DIR/whisper/tiny` |
| x-asr | `x_asr_model_dir.parent / model_name`，每个块长使用自己的 `chunk-...-model` 目录 |

HF / ModelScope 的 X-ASR 远端文件包含 `deployment/models/chunk-...-model/` 前缀；`strip_prefix` 去掉该前缀，保持本地目录内直接出现四个加载文件。

权重下载完整不等于运行环境已经准备完成：

- `runtime_extra` 对应项目 extras：`sensevoice`、`firered`、`qwen3asr`、`formalasr`、`whisper`、`x-asr`。
- SenseVoice 现有适配器还要求 `SENSEVOICE_SRC_PATH/model.py`；参考实现来自 [SenseVoice 官方仓库](https://github.com/QwenAudio/SenseVoice)。这是推理代码，不应由任意镜像自动执行。
- FireRedASR2 现有适配器要求包含 `fireredasr2s` 的源码目录，或之后提供等价的已安装官方运行包。只安装当前 `firered` extra 与 AED 权重，不能据此声称所有源码依赖均满足。
- FireRedVAD 是独立可选模型。当前离线 AED 调用 `FireRedAsr2`，没有加载 VAD / LID / Punc 系统；流式会话的 FireRedVAD 不可用时已有能量检测回退。因此没有把整个 FireRedVAD、LID、Punc 系列作为 AED 的强制下载。各模块独立的设计见 [官方说明](https://github.com/FireRedTeam/FireRedASR2S#usage-of-each-module)。

本次未修改 API 密钥、已有模型文件或运行环境配置。
