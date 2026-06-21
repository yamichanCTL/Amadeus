import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  lang: 'zh-CN',
  title: 'Amadeus',
  description: 'Agentic Voice Assistant 项目文档',
  base: '/',
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
  ],

  themeConfig: {
    // 顶部导航栏
    nav: [
      { text: '首页', link: '/' },
      { text: '索引', link: '/README' },
      { text: 'Amadeus', link: '/asrapp/README' },
      { text: '桌面端', link: '/desktop/README' },
      { text: '开发环境', link: '/development/README' },
      { text: '安装迁移', link: '/asrapp/installation/README' },
      { text: 'CHANGELOG', link: '/CHANGELOG' },
    ],

    // 左侧边栏 — 树状层级
    sidebar: {
      '/': [
        {
          text: 'Amadeus 文档',
          collapsed: false,
          items: [
            { text: '首页', link: '/' },
            { text: '文档索引', link: '/README' },
            { text: '开发环境', link: '/development/README' },
            { text: '变更日志', link: '/CHANGELOG' },
          ]
        },
        {
          text: '当前文档',
          collapsed: false,
          items: [
            { text: '桌面端', link: '/desktop/README' },
            { text: '语音识别', link: '/desktop/SPEECH_RECOGNITION' },
            { text: '输入、浮窗与注入', link: '/desktop/INPUT_AND_OVERLAYS' },
            { text: 'TTS 音色与参数', link: '/desktop/TTS_VOICE' },
            { text: '开发环境', link: '/development/README' },
          ]
        },
      ],
      '/asrapp/': [
        {
          text: '📱 Amadeus',
          collapsed: false,
          items: [
            { text: '项目总览', link: '/asrapp/README' },
            { text: '架构总览', link: '/asrapp/ARCHITECTURE' },
            { text: '快速开始', link: '/asrapp/QUICKSTART' },
          ]
        },
        {
          text: '🧰 安装与迁移',
          collapsed: true,
          items: [
            { text: '安装总览', link: '/asrapp/installation/README' },
            { text: '后端环境', link: '/asrapp/installation/BACKEND' },
            { text: '桌面前端', link: '/asrapp/installation/DESKTOP' },
            { text: 'Android', link: '/asrapp/installation/ANDROID' },
            { text: '第三方库与模型', link: '/asrapp/installation/THIRD_PARTY_MODELS' },
            { text: '迁移检查表', link: '/asrapp/installation/MIGRATION' },
          ]
        },
        {
          text: '🔧 Backend 后端',
          collapsed: true,
          items: [
            { text: '后端总览', link: '/asrapp/backend/README' },
            { text: 'API 端点详解', link: '/asrapp/backend/API' },
            { text: '部署说明', link: '/asrapp/backend/DEPLOY' },
            { text: 'ASR 引擎管理', link: '/asrapp/backend/ENGINES' },
            { text: '流式识别', link: '/asrapp/backend/STREAMING' },
            { text: '异步任务', link: '/asrapp/backend/TASKS' },
          ]
        },
        {
          text: '⚡ Runner 运行时',
          collapsed: true,
          items: [
            { text: '管线总览', link: '/asrapp/runner/README' },
            { text: '编排器', link: '/asrapp/runner/ORCHESTRATOR' },
            { text: 'Agent 适配器', link: '/asrapp/runner/AGENTS' },
            { text: 'TTS 引擎', link: '/asrapp/runner/TTS' },
            { text: '记忆系统', link: '/asrapp/runner/MEMORY' },
            { text: '技能系统', link: '/asrapp/runner/SKILLS' },
          ]
        },
        {
          text: '🖥️ Frontend 客户端',
          collapsed: true,
          items: [
            { text: '客户端总览', link: '/asrapp/frontend/README' },
            { text: 'Desktop (Electron)', link: '/asrapp/frontend/DESKTOP' },
            { text: 'Android', link: '/asrapp/frontend/ANDROID' },
          ]
        },
        {
          text: '🎙️ ASR 系统',
          collapsed: true,
          items: [
            { text: 'ASR 总览', link: '/asrapp/asr/README' },
            { text: '引擎对比', link: '/asrapp/asr/ENGINES' },
            { text: '流式设计', link: '/asrapp/asr/STREAMING' },
            { text: 'X-ASR 接入', link: '/asrapp/asr/X_ASR' },
          ]
        },
        {
          text: '🎯 设计决策',
          collapsed: true,
          items: [
            { text: '设计索引', link: '/asrapp/design/README' },
            { text: '双架构设计', link: '/asrapp/design/DUAL_ARCH' },
            { text: 'Agent Adapter', link: '/asrapp/design/CLI_ADAPTER' },
            { text: 'Router + Fallback', link: '/asrapp/design/ROUTER_FALLBACK' },
            { text: '安全设计', link: '/asrapp/design/SECURITY' },
          ]
        },
      ],
    },

    // 搜索
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无结果',
            resetButtonTitle: '清除',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    // 社交链接
    socialLinks: [
      { icon: 'github', link: 'https://github.com' },
    ],

    // 页脚
    footer: {
      message: 'Amadeus Documentation',
      copyright: 'Copyright © 2026',
    },

    // 编辑链接
    editLink: {
      pattern: '',
      text: '在 GitHub 上编辑此页',
    },

    // 大纲
    outline: {
      level: [2, 3],
      label: '本页目录',
    },

    // 文档页脚
    docFooter: {
      prev: '上一页',
      next: '下一页',
    },

    // 上次更新
    lastUpdated: {
      text: '最后更新于',
    },

    // 暗色模式
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '回到顶部',
    langMenuLabel: '语言',
  },

  // Markdown 配置
  markdown: {
    lineNumbers: true,
  },
})
