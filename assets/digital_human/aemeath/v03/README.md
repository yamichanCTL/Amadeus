# 艾米斯数字人：Blender 说话样片

> 本文记录本地 Blender 样片阶段。后续实时语音和桌宠集成见 `doc/reports/2026-09-29-digital-human-amadeus-integration.md`。公开仓库与 Release 不提供角色模型、贴图或 `.blend`；下述素材仅保留在开发者本机，用户通过应用的本地模型导入功能使用自行准备的 GLB。

## 直接体验

- **可编辑文件：`Aemeath_DigitalHuman_v03.blend`**。打开后，将鼠标移到 3D 视图，按空格播放／暂停。
- **成片：`Aemeath_Talking_v03.mp4`**，640×640、30 fps、15.5 秒。
- **口型对照：`mouth_contact_sheet.jpg`**；原始正面图在 `mouth_atlas/`，斜侧面检查图在 `threequarter_review/`。
- 在 Amadeus 根目录也可运行 `scripts/digital_human/open_blender_preview.ps1` 打开工作文件。

声音及 31 张贴图已打包，普通 Blender 5.2.2 无需 MMD 插件或播放脚本即可重开。第一次打开需要等待材质加载。生成的视频可用于查看流畅播放效果；本次未测量 Blender 界面实时帧率。

## 本版做了什么

1. 保留单个艾米斯原模型、骨架、149 个形态键（含 Basis）、原材质与灯光。
2. 使用原模型 `あ / い / う / え / お` 五元音，加入短过渡，跟随声音强弱与停顿。
3. 使用真实录制的 Windows SAPI 口型事件进行近似口型分组；静音时五元音归零。
4. 加入微笑、眨眼、轻微头部动作；全部保存为 Blender 原生关键帧。
5. 将 MMD 插件专用的 69 处静态组合系数／UV 缩放依赖转成原生自定义属性，保留动态表情控制及表达式。
6. 移除 8 条经过检查的冗余恒等 FCurve，避免极小控制值被吸附为零。

编辑位置：

| 内容 | 位置 |
| --- | --- |
| 口型、眨眼和嘴角 | `.placeholder` 的形态键 Action |
| 显示网格 | `AEMEATH_OFFICIAL_DISPLAY`，保留原驱动 |
| 头部动作 | `AEMEATH_OFFICIAL_RIG` 的 Action |
| 音频 | 视频序列编辑器，音轨从第 1 帧开始 |

时间换算：`frame = 1 + time_s × 30`。结束帧 465，原始音频 15.0515 秒，最后留有闭口静止时间。

## 验证

`verification.json` 记录了全新进程、恢复出厂设置、禁用自动执行的结果：

- 11 个整数／小数帧及正逆重复跳帧：全部顶点与构建参考一致。
- 全部 465 帧的控制值与显示值最大差约 `2.85e-8`。
- 198 个静音帧五元音均为零，首尾中性几何恢复误差为零。
- 279 个驱动全部有效，贴图及音频已打包。
- 独立读取原模型，确认 130108 顶点、全部 149 个形变坐标、拓扑、UV 与 44 个材质槽一致。

旧 v01、v02 及其失败报告保留供追踪；日常体验请使用 v03。

## 当前边界

- 本版为 **离线 Blender 样片**，尚未接入实时语音回复、语音打断或桌宠 IPC。
- 声音是 **Microsoft Huihui Desktop 合成测试音**，不是最终角色音色。
- 中文口型分组是近似映射，尚未做语言学对齐或逐音素精度验收。[微软官方映射表](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.visemereached?view=netframework-4.8.1)描述的是美式英语。
- `M` 只在对照图中观察，样片用中性嘴形闭口。
- 本次没有新增头发、衣服或身体物理模拟。头部动作是小幅编排。
- 源 MMD 组合系数在构建时转存；以后修改源插件中的组合系数，需要重新构建才能同步。

## 重建

从 Amadeus 根目录运行。为保留手工修改，请将输出换成新的版本目录，不覆盖已在 Blender 中编辑的文件。

```powershell
& scripts/digital_human/prepare_speech_fixture.ps1

& 'D:/steam/steam/steamapps/common/Blender/blender.exe' `
  --background --factory-startup --disable-autoexec --python-exit-code 1 `
  --python scripts/digital_human/build_blender_preview.py -- `
  --source '../Dance_Project/Wuthering_Waves_V9_AEMEATH_DYNAMIC_REVIEW.blend' `
  --speech '.runtime/digital_human_v1/speech' `
  --output 'assets/digital_human/aemeath/v03' --version v03 `
  --resolution 640 --render-atlas --render-frame 53

& 'D:/steam/steam/steamapps/common/Blender/blender.exe' `
  --background --factory-startup --disable-autoexec --python-exit-code 1 `
  --python scripts/digital_human/verify_blender_preview.py -- `
  --blend 'assets/digital_human/aemeath/v03/Aemeath_DigitalHuman_v03.blend'
```

原始 Blender 文件只读使用。原桌宠 GLB 尚未替换。下一步是导出这些口型并对接实时音频播放时钟，处理打断后的停口与聆听状态。
