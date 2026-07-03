let electron
try {
  electron = require('electron/main')
} catch {
  electron = require('electron')
}

const app = electron.app || electron.default?.app
const BrowserWindow = electron.BrowserWindow || electron.default?.BrowserWindow
const fs = require('node:fs/promises')
const path = require('node:path')

const target = process.argv.find((arg) => /^https?:\/\//.test(arg)) || 'http://127.0.0.1:5173/'
const targetIndex = process.argv.indexOf(target)
const outDir = targetIndex >= 0 && process.argv[targetIndex + 1]
  ? process.argv[targetIndex + 1]
  : path.resolve(process.cwd(), '../../tmp/ui-screenshots')

const visualState = {
  state: {
    settings: {
      serverUrl: '',
      backendConfirmed: false,
      theme: 'windows',
      offlineEngine: 'sensevoice',
      streamingEngine: 'x-asr',
      defaultLanguage: 'zh',
      enablePunctuation: true,
      showDesktopCaptions: true,
      triggerType: 'keyboard',
      triggerKey: 'AltRight',
      injectMode: 'inject',
      llmProvider: 'deepseek',
      llmBaseUrl: 'https://api.deepseek.com',
      llmModel: 'deepseek-chat',
      llmApiToken: '',
      llmPolishPrompt: '修正 ASR 错字和标点，保持原意，只输出处理后的文本。',
      llmAutoPolish: true,
      llmAutoTranslate: false,
      archiveDir: '',
      allowServerDataCollection: false,
    },
    history: [],
    summaryWorkspace: {
      date: '2026-07-03',
      userId: 'dsm',
      category: '实时转录',
      startTime: '00:00',
      endTime: '23:15',
      maxInputChars: 24000,
      loading: false,
      error: '',
      saveMessage: '已保存到本机总结日志',
      result: {
        summary: '## 总览\n\n- **完成** Prompt 卡片与设置分页\n- 当日总结状态可跨页面保留\n\n## 决定与待办\n\n1. 保持本机隐私模式\n2. 继续验证 Windows 实机',
        model: 'deepseek-chat',
        source_count: 12,
        input_chars: 620,
        estimated_input_tokens: 310,
        chunk_count: 1,
        truncated: false,
        date: '2026-07-03',
        time_range: '00:00-23:15',
      },
    },
  },
  version: 35,
}

const pages = [
  ['transcribe', '语音识别'],
  ['models', '模型管理'],
  ['settings', '设置'],
  ['summary', '当日总结'],
]

app.on('window-all-closed', () => {})

async function capture(page, label) {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  await win.loadURL(target)
  await win.webContents.executeJavaScript(`localStorage.setItem('asr-desktop-store', ${JSON.stringify(JSON.stringify(visualState))}); location.reload()`)
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.sidebar nav button')].find((item) => item.textContent?.includes(${JSON.stringify(label)}))
    button?.click()
    return Boolean(button)
  })()`)
  if (!clicked) throw new Error(`sidebar page not found: ${page}`)
  await new Promise((resolve) => setTimeout(resolve, 450))
  if (page === 'settings') {
    await win.webContents.executeJavaScript(`([...document.querySelectorAll('.settings-tabs button')].find((item) => item.textContent?.includes('识别与字幕')))?.click()`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (page === 'models') {
    await win.webContents.executeJavaScript(`document.querySelector('.model-tabs button:nth-child(2)')?.click()`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const image = await win.webContents.capturePage()
  const file = path.join(outDir, `${page}-current-1440x960.png`)
  await fs.writeFile(file, image.toPNG())
  win.destroy()
  return file
}

app.whenReady().then(async () => {
  try {
    await fs.mkdir(outDir, { recursive: true })
    const files = []
    for (const [page, label] of pages) files.push(await capture(page, label))
    console.log(JSON.stringify(files, null, 2))
  } finally {
    app.quit()
  }
})
