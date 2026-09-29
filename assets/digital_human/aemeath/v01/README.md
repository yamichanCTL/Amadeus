# 艾米斯数字人 v01：Blender 说话预览

**此版本独立重开验证失败，保留作问题记录。请使用相邻 `v03` 目录中已通过验证的版本。**
v01 部分表情驱动依赖 MMD 插件的 RNA 属性；未加载该插件时眨眼和微笑不能正确还原。详见 `verification_initial_without_mmd_registration.json`。

## 体验

打开本目录的 **Aemeath_DigitalHuman_v01.blend**，鼠标移到 3D 视图，按 **空格**播放／暂停。

- 时间轴：1–465 帧，30 fps；语音约 15 秒，结束后保留闭口。
- 音频已打包进 `.blend`，另在 `audio/` 保留原始 WAV、事件和包络。
- 成片：`Aemeath_Talking_v01.mp4`。
- 口型对照：`mouth_contact_sheet.jpg`；单独原图在 `mouth_atlas/`。
- 文件刚打开可能需要短暂编译材质；以渲染视频判断稳定播放的观感。

## 已实现

1. 保留单个艾米斯原模型：130108 顶点、149 个形态键（含 Basis）、原骨架、原材质及灯光。
2. 恢复原模型 `あ / い / う / え / お` 五元音控制。
3. 根据本地 WAV 的实际时间和音量包络生成口型原生关键帧，静音闭口。
4. 用 Windows SAPI 实际口型事件做近似口型分组，加入短过渡。
5. 添加轻微头部动作、眨眼和嘴角表情，动作均为可编辑关键帧。

口型键在 **`.placeholder` 的形态键 Action** 中；显示网格 `AEMEATH_OFFICIAL_DISPLAY` 继续读取原驱动。头部动作在 `AEMEATH_OFFICIAL_RIG`。声音在视频序列编辑器。无需安装 MMD 插件或运行播放脚本。

## 范围与限制

- 这是 **Blender 离线样片**，尚未连接 Amadeus 的实时语音、语音打断与桌宠 IPC。
- 演示声音为 Windows **Microsoft Huihui Desktop**，不是最终角色音色。
- SAPI 的口型分组在中文中的准确性尚未验证，当前不是精准中文音素对齐或专业唇读动画。
- 映射参考：[微软 VisemeReached 官方说明](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.visemereached?view=netframework-4.8.1)，其表格描述美式英语；本样片保留实际中文引擎事件供后续校准。
- `M` 仅保留在对照图中观察；动画以原中性姿态实现闭口。
- 头部动作是小幅编排；本次没有新增头发、衣服或身体物理模拟。

## 重建

在 Amadeus 项目根目录运行，先生成音频，再调用本机 Blender：

```powershell
& scripts/digital_human/prepare_speech_fixture.ps1

& 'D:/steam/steam/steamapps/common/Blender/blender.exe' `
  --background --disable-autoexec --python-exit-code 1 `
  --python scripts/digital_human/build_blender_preview.py -- `
  --source '../Dance_Project/Wuthering_Waves_V9_AEMEATH_DYNAMIC_REVIEW.blend' `
  --speech '.runtime/digital_human_v1/speech' `
  --output 'assets/digital_human/aemeath/v01' `
  --resolution 640 --render-atlas --render-frame 53
```

不要在 Blender 界面手动编辑此工作文件后直接重建覆盖。先另存新版本，再改变生成脚本的输出目录。

源文件只读使用，原桌宠 GLB 未替换。后续确认嘴部观感后，将同一套口型权重规则接到实时音频播放时钟，再处理打断时的闭口与动作复位。
