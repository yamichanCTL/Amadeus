# Blender 数字人第一阶段：艾米斯说话样片

## 交付

- 当前可用工作文件：`assets/digital_human/aemeath/v03/Aemeath_DigitalHuman_v03.blend`。
- 视频：同目录 `Aemeath_Talking_v03.mp4`，640×640、30 fps、465 帧、15.5 秒，H.264 + AAC，约 1.20 MB。
- 口型九格对照：`mouth_contact_sheet.jpg`；斜侧面检查：`threequarter_review/`。
- 最终 Blender GUI 已打开 v03，窗口标题和进程确认。未以窗口实际播放帧率作为本次性能验收结果。

## 已跑通的流程

原 Blender 模型 → 原生五元音和表情控制 → 本地合成音频／原始口型事件／120 Hz 包络 → 30 fps 原生关键帧 → 打包音频的可编辑文件 → 普通 Blender 独立重开 → 带声音的视频。

完整保留单个艾米斯的 130108 顶点、149 形变（含 Basis）、拓扑、UV、44 材质槽及原骨架。加入短口型过渡、静音闭口、眨眼、轻微微笑和头部动作。

## 修复了两个真实问题

1. **MMD 插件依赖**：v01 的 69 处静态系数路径在无插件环境下不能解析，导致 26 个驱动失效。将组合系数和 UV 缩放改存原生 IDProperty，动态控制和表达式保留。v01 失败证据保存在其目录。
2. **微小控制值被归零**：v02 的原始恒等 FCurve 把不超过 0.0001 的输入吸附到零端点。对源曲线端点、外推、句柄和修改器检查后，v03 只移除 8 条冗余恒等曲线，驱动及表达式未删除。没有放宽检查阈值。因果实验记录在 `v02/small_control_diagnosis.json`。

第二项与 Blender 官方 `fcurve_eval_keyframes_interpolate` 使用的端点匹配容差相符，且已在本机 5.2.2 独立进行 0.0001／0.000101 边界实验。[官方源码](https://github.com/blender/blender/blob/main/source/blender/blenkernel/intern/fcurve.cc)

## 验证结果

完整记录见 `v03/verification.json`，全新进程使用 `--factory-startup --disable-autoexec`。

| 项目 | 结果 |
| --- | --- |
| 11 参考时刻、26 次正逆及重复跳帧 | 顶点和显示形变与构建参考误差 0 |
| 全部 465 帧控制与显示一致性 | 最大差 2.85e-8，原门槛 1e-6 |
| 198 个静音帧 | 五元音均为 0 |
| 首末中性复位 | 几何误差 0 |
| 279 个驱动 | 全部有效，无未解析路径 |
| 图片和音频 | 31 张图片及 1 条音频已打包 |
| 原始模型逐形变／拓扑／UV 比对 | 一致 |
| 原始音频 | 16kHz、单声道、PCM16、15.0515 秒，第 1 帧起 |
| 视频 | 音视频均从 0 秒开始，465 帧，全片解码成功 |

正面九格与斜侧面静帧已实际查看。完整视频已经生成并通过解码检查；不将静帧检查描述为逐音素人工听看验收。

源文件 `Dance_Project/Wuthering_Waves_V9_AEMEATH_DYNAMIC_REVIEW.blend` 始终只读，SHA256 为 `d50e05f5c4c4924c55fff6429551101d93731b4e556a98726f142a33797b0d93`。旧舞蹈／物理研究没有恢复运行。原桌宠 GLB 未替换。

## 当前限制与下一步

使用 Microsoft Huihui Desktop 合成测试音；中文 viseme 采用近似分组，尚未验证精准中文音素。口型事件的 22050 Hz 输出时轴曾不一致，改用 16000 Hz 后与音频结束相差 0.5 ms；失败证据和音频生成脚本保留。

当前为离线样片。实时音频时钟、打断停口、聆听／思考／执行动作状态机、桌宠 IPC 与 Windows 新包仍待下一阶段。下一步以这个工作文件的口型为基础导出运行时资产，并接到 Amadeus 实际输出音频。
