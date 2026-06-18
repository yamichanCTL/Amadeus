# Plan: 重写 asrapp 项目文档为多 MD 树状结构

## 目标

按新文档规范，将 asrapp 的 2 个巨型 MD（README + ARCHITECTURE）拆分为 ~30 个专题 MD，形成层级树状结构，每个文件标注父子链接，支持网页逐层点击展开。

## 文档树结构

```
doc/asrapp/
├── README.md                      # 入口: 项目定位 + 文档导航树
├── ARCHITECTURE.md                # 架构总览
├── QUICKSTART.md                  # 快速开始
├── backend/
│   ├── README.md                  # 后端总览
│   ├── API.md                     # 15 个端点详解
│   ├── DEPLOY.md                  # 部署说明
│   ├── ENGINES.md                 # ASR 引擎管理
│   ├── STREAMING.md               # 流式识别
│   └── TASKS.md                   # 异步任务
├── runner/
│   ├── README.md                  # Runner 总览
│   ├── ORCHESTRATOR.md            # 编排器
│   ├── AGENTS.md                  # Agent 适配器
│   ├── TTS.md                     # TTS 引擎
│   ├── MEMORY.md                  # 记忆系统
│   └── SKILLS.md                  # 技能系统
├── frontend/
│   ├── README.md                  # 前端总览
│   ├── DESKTOP.md                 # Electron 桌面端
│   └── ANDROID.md                 # Android
├── asr/
│   ├── README.md                  # ASR 总览
│   ├── ENGINES.md                 # 引擎对比
│   └── STREAMING.md               # 伪流式设计
└── design/
    ├── README.md                  # 设计决策
    ├── DUAL_ARCH.md               # 双架构
    ├── CLI_ADAPTER.md             # Agent Adapter
    └── SECURITY.md                # 安全
```

## 影响范围

- `doc/asrapp/` 下 ~30 个 MD 文件（新建/重写）
- `doc/CHANGELOG.md` 更新

## 风险

文档量大，需保持一致性。每个文件必须包含父子链接。
