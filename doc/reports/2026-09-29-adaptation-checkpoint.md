# Amadeus 适配代码检查点

日期：2026-09-29。用户要求先提交已有适配，再规划爱弥斯数字人。

## 本次保存范围

- FormalASR 离线引擎、模型配置界面、Windows 临时音频文件修复、安装及验证脚本。
- 已有实时语音提供商适配、统一配置、采集/播放/打断处理及测试。
- 已有 Windows 透明置顶桌宠、主界面 3D 角色及运行所需 GLB。
- 相关依赖、空凭据配置模板、Windows 启动脚本及使用文档。

本地 `.env`、模型权重、运行目录、构建输出以及 `research/` 中的旧评测会话、截图、工单和独立 Demo 不纳入提交。已有评测文件仍保留在本机。

## 本轮检查

- 后端 FormalASR、分块转写、实时语音及 Qwen/Higgs/Grok 协议回归：86 项通过。
- 前端模型配置、实时对话、Codex 对话页面、语音配置、WebSocket、麦克风：6 个测试文件，44 项通过。
- 渲染端 TypeScript `tsc --noEmit` 与 Electron TypeScript `tsc -p tsconfig.node.json --noEmit` 通过。
- `git diff --check` 通过。
- 未调用外部模型 API，未重新启动服务或重新打包应用。本轮不把已有构建报告替代为新的桌面端体验验收。

初次 pytest 在系统临时目录遇到 Windows 权限错误，使用项目内独立临时目录后上述 86 项通过。
随后扩展到原有 `test_codex_runtime.py`，前三项失败后停止：一项断言 POSIX 文件权限位；两项依赖无扩展名、带 Unix shebang 的假 CLI，Windows `subprocess.Popen` 不能直接执行。
相关测试夹具及 transport 文件与提交前 HEAD 一致，未修改测试以掩盖问题。
因此本检查点不声称全套测试通过，也不据这些测试证明新增 Codex 工作模式或 Windows ACL 已验收。

`uv.lock` 的包名/版本集合与 HEAD 相同；较大的文本差异主要来自镜像 URL 切换，保留当前锁文件。

## 当前能力边界

- FormalASR 接入有效，但现有 4 条合成语音改口/撤回样例失败，详见 `2026-09-29-formalasr-integration.md`。
- 现用 GLB 只有 6 个表情形变、没有导出动画片段；现有轻动作由程序生成。
- 嘴部按 speaking 状态周期性开合，尚未跟随实际音频时间或音素；这正是后续数字人计划的首要改善项。

本提交保存已有实现和已知限制；后续数字人实现单独推进。
