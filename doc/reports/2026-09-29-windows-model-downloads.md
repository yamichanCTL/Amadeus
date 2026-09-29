# Windows 模型智能下载验证

## 交付

- 入口：模型管理 → ASR 模型设置 → 下载本地模型。
- 6 类引擎、10 个权重版本：SenseVoiceSmall、FireRedASR2-AED、Qwen3-ASR-1.7B、FormalASR-1.7B、Whisper tiny/base、X-ASR 160/480/960/1920 ms。
- 地区初始建议来自系统时区，可手动修改。大陆优先已核实的 ModelScope 国内仓库或 HF-Mirror；其他地区优先官方 HF/GitHub；只列各模型真正具有的来源。
- 来源固定版本、官方哈希校验、临时目录下载、暂停续传、失败换源、并发上限 2。完整校验后才替换目标目录，保留旧目录备份，并与引擎加载共用锁。
- 本机托管环境可安装对应 Python extra，之后自动重启；环境更新/修复保留已选 extra 与模型文件。
- 权重和运行组件分别显示。SenseVoice、FireRed 仍需配套官方源码；GPU 驱动不是权重下载的一部分。

## 实际 Windows 验证

使用独立 `.runtime/model-download-preview/local-runtime`，未依赖项目 `.venv` 运行后端；安装专用 Python 3.12.12、基础包和 Whisper extra。无真实麦克风或云端模型调用，无 API 密钥写入此测试配置。

| 项目 | 结果 |
| --- | --- |
| Electron 实际界面 | 模型下拉 10 项、地区/来源选择、目标路径、权重/组件状态、完成按钮与现有识别设置同页展示 |
| Whisper tiny 下载 | 78,205,610 字节；选择大陆自动来源，实际来源记录 HF-Mirror；全流程 23.58 秒 |
| 暂停/续传 | 在 1,052,816 字节时暂停，确认未标为可用，继续完成 |
| 完整性 | 模型文件 SHA-256、普通仓库文件 Git blob SHA-1 均按官方清单校验 |
| CPU 加载 | faster-whisper tiny、CPU/int8，成功 |
| 识别 | 合成语音 PCM 转 WAV 后返回中文文本；24.61 秒，包含冷启动开销；这是功能验证，不是速度/准确率排名 |
| 更新后保留 | 更新本机后端后，已选 Whisper extra 与已校验权重仍可用 |
| 后端测试 | 30 项通过：路径拒绝、完整性、损坏拒收、Range/ETag 续传、忽略 Range、持久化恢复、取消/重启竞争、加载锁、换源、ModelScope 固定提交、并发、API 参数 |
| 前端/运行管理测试 | 21 项通过；两个 TypeScript 配置检查通过 |

初次真实下载暴露 Windows MAX_PATH 问题，已将 staging/partial 标识由 64 缩至 20 个十六进制字符；完整校验值保持不变。修复后真实下载成功。独立审查还修复了取消和重启竞争，以及加载途中替换权重的问题。

pytest 默认系统临时目录访问被拒；改用项目内独立临时目录后全部通过，未改系统权限。pytest 缓存写入仍有权限警告，不影响测试结果。

机器证据：`.runtime/model-download-preview/download-report.json`、`ui-report.json`、`model-downloads.png`，以及 `local-runtime/runtime-extra-qa.json`。辅助脚本在 `scripts/windows/verify_model_downloads.py` 与 `verify_model_download_ui.cjs`。

## 安装包

`frontend/desktop/release-model-downloads/Amadeus-Windows-Setup-0.1.0.exe`

- 157,267,286 字节。
- SHA-256：`4E82A77893F9C0245A56B8EE286CAE16A307A40A853FFC7949C3CF61F3263F2F`。
- NSIS 构建成功；实际运行验证使用同次构建的 `win-unpacked/Amadeus.exe`，没有覆盖执行用户已有安装向导。
- 已检查 backend-bundle 不含 `.env`、数据库、日志和本地权重；打包后的下载管理代码哈希与源码一致。

## 范围和限制

只有 Whisper tiny 做了完整权重下载→加载→识别。其他来源做了官方清单与小文件校验，不能等同于全部大模型/GPU 推理验证；来源详情见 `doc/model-download-sources.md`。

HF-Mirror 部分请求实际重定向到 Hugging Face。本次 Windows 网络可完成下载，不据此承诺所有大陆网络直连可用；内置清单只避免查询 HF metadata API。

当前应用仍内置爱弥斯 GLB。提供了 `scripts/digital_human/create_distribution_manifest.py` 生成版本、大小、SHA-256、两地地址清单；没有上传模型，远端 3D 资源下载等待托管地址。
