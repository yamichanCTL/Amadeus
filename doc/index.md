---
layout: home

hero:
  name: "Amadeus"
  text: "Agentic Voice Assistant 文档"
  tagline: 语音输入 · ASR 识别 · Agent 执行 · TTS 合成 · 桌面与移动客户端
  actions:
    - theme: brand
      text: 文档索引
      link: /README
    - theme: alt
      text: 变更日志
      link: /CHANGELOG

features:
  - icon: 🎧
    title: 完整文档树
    details: 架构、后端、Runner、前端、ASR 与设计决策的专题文档。
    link: /asrapp/README
  - icon: 🖥️
    title: 桌面端
    details: Electron 客户端、实时语音、Higgs TTS、变声器和输出设备设置。
    link: /desktop/README
  - icon: 📝
    title: 开发环境
    details: 工作区编辑器设置、文档站和任务工作流约定。
    link: /development/README
---

## 文档入口

| 目录 | 说明 |
|------|------|
| [文档索引](README.md) | asrapp 当前文档入口 |
| [完整文档树](asrapp/README.md) | 外层 doc 合并迁入的 asrapp 专题文档 |
| [桌面端](desktop/README.md) | 桌面客户端、TTS 与变声器 |
| [开发环境](development/README.md) | 工作区开发工具和编辑器约定 |
| [变更日志](CHANGELOG.md) | 当前 asrapp 文档变更记录 |

## 开发约定

所有任务必须遵循 **Plan → 执行 → CHANGELOG → 文档更新** 流程。
