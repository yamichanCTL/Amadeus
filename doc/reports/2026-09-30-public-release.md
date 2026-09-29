# v0.1.0 公开发布检查

用户确认公开版不包含角色资产，改由使用者本地导入。原模型文件保留在开发者本机，没有随源码或本次 Release 上传。

## 代码与分发

- `.gitignore` 排除根依赖目录、研究目录、本地模型/权重、GLB/GLTF、Blender 文件、研究媒体和生成产物。
- 公开提交直接基于此前远端 master，整理本地尚未推送的功能改动；包含 GLB 的旧本地开发提交保留在本地分支，不纳入公开提交历史。
- Electron 打包规则另行排除所有 GLB/GLTF，避免开发机素材被 Vite 复制后误带入安装包。
- 检查 `app.asar`：无 GLB/GLTF/Blender/ASR 权重或 `.env`；主进程、模型导入和运行管理模块与本次编译结果一致。
- 后端仅携带白名单源码、依赖清单和模型下载目录；密钥、模型文件、日志、数据库均未打包。

## 本地 GLB 导入

使用新建的 `.runtime/public-release-qa` 配置，在实际打包应用中验证：

1. 首次启动无角色模型，实时页面显示导入入口。
2. 通过 Windows 原生文件选择窗口选择本机已有 GLB，文件只复制到该测试配置的 `avatars` 目录。
3. 主窗口显示模型，读取到 12 个形态键；播放合成 PCM 试听后实际口型权重大于 0.05。
4. 开启独立透明桌宠，成功读取同一本地模型并跟随 PCM 动嘴。
5. 原始 GLB 未修改；公开安装包中没有该文件。

GLB 校验/复制/清除、界面状态订阅、模型资源释放/视角归一化、模型下载 UI、运行管理及实时口型专项测试共 **48 项通过**；两套 TypeScript 检查通过。下载器后端 **30 项通过**，完整下载与推理证据见前一日模型下载报告。

机器证据保存在 `.runtime/public-release-qa/{empty-report.json,import-report.json,no-avatar.png,imported-avatar.png}`，这些测试输出不提交。NSIS 安装包构建成功；此次没有覆盖安装用户已有正式应用，界面验证使用同构建的 `win-unpacked`。

## 安装包

- `frontend/desktop/release-public/Amadeus-Windows-Setup-0.1.0.exe`
- 大小：96,910,988 字节。
- SHA-256：`32c52bc356133ebe5530a1cc0f9dcfc3894e7ae82421ced6d536b8ac2acb2545`
- 同目录提供 `.blockmap` 和 `SHA256SUMS.txt`，通过 GitHub Release 分发，不进入 Git 源码树。

## 推送环境

原远端使用 HTTPS，保存的凭据返回 401。用户指出已有 SSH 后，确认 SSH 密钥和推送权限正常；当前执行环境的 `SHELL=PowerShell` 导致 SSH 代理命令里的 `exec` 报错，将这次 Git 调用的 SHELL 指向 Git 自带 Bash 后推送预检成功。没有更改 SSH 私钥或全局安全设置；Release 使用用户已登录的 GitHub Chrome 页面。
