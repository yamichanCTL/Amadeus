# 麦克风收音连续性测试报告

> **父文档**: [← 返回桌面端](../desktop/README.md)
> **相关计划**: [麦克风收音间断与非原始音修复](../plans/2026-06-29-fix-microphone-capture-dropouts.md)

## 根因

离线录音与 TTS 一句话录音共用 `AudioRecorder`。该类虽然直接打开所选实体麦克风，但请求约束强制启用了浏览器 `echoCancellation` 和 `noiseSuppression`。这不是原始麦克风波形，AEC/NS 的语音门限会吞掉安静音素并产生抽吸、断续感。

第二个问题位于 PCM 时间轴：AudioWorklet 原先只发送裸 PCM buffer，renderer 不知道每块对应的音频帧位置。任何缺失 block 都会被直接从 WAV 中删除，后续波形前移，在拼接边界形成时间压缩和跳变。

## 修复

- `AudioRecorder` 的实体麦克风约束统一关闭 AEC、降噪和自动增益；实时双工 `PcmStreamer` 的回声策略保持不变。
- Worklet 消息增加单调序号和 `currentFrame` 帧位置。
- WAV 聚合器按帧位置检测 gap/overlap；缺失区间以零样本保持真实时间轴，重复或重叠样本不会再次写入。
- 每轮录音重置帧基准；检测到 gap/overlap 时输出明确诊断，不再静默生成被压短的 WAV。

## 先失败、后修复

```text
修改前纯输入约束：echoCancellation=true / noiseSuppression=true，FAIL
修改前缺失 1 block：期望 12288 samples，实际 8192 samples，FAIL
修改后缺失 1 block：12288 samples，缺失区间补齐，PASS
连续两次录音：帧基准正确重置，PASS
```

## 压力与回归

```text
专项测试：15 passed
30 秒压力：11250 blocks / 3 gaps / 1440000 samples / 约 20.6 ms
前端全量：48 passed
Renderer TypeScript：passed
Electron TypeScript：passed
Vite production build：passed
Windows unpacked 目录打包：passed
```

专项入口：

```bash
bash scripts/test_microphone_capture_continuity.sh
```

## 环境边界

本轮 Windows 实体 DJI 麦克风 E2E 启动被执行额度限制拒绝，不能绕过重试。E2E 已扩展为录制约 1.2 秒实体麦克风，并检查实际 track DSP 设置、WAV 样本和 `gapSamples === 0`；待执行条件恢复后运行：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/run_amadeus_windows_e2e.ps1
```
