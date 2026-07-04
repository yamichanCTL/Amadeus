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
  : path.resolve(process.cwd(), '../../doc/assets/ui')

const result = {
  summary: '## 总览\n\n当日总结正在按大模型返回的 token **逐字刷新**，完成后自动保存。\n\n## 关键要点\n\n- 音频与 JSON 已放入同一记录目录\n- ASR 结果会先填入本软件输入框\n- 点击 X 可选择保留后台或完全退出\n\n## 下一步\n\n继续执行端到端验证。',
  model: 'deepseek-chat',
  provider: 'deepseek',
  source_count: 18,
  input_chars: 1680,
  estimated_input_tokens: 840,
  chunk_count: 2,
  truncated: false,
  date: '2026-07-04',
  time_range: '00:00-12:45',
}

const visualState = {
  state: {
    settings: {
      serverUrl: 'http://127.0.0.1:8000', backendConfirmed: true, theme: 'windows',
      offlineEngine: 'sensevoice', streamingEngine: 'x-asr', defaultLanguage: 'zh',
      llmProvider: 'deepseek', llmBaseUrl: 'https://api.deepseek.com', llmModel: 'deepseek-chat', llmApiToken: 'visual-test-token',
      archiveDir: 'G:\\Amadeus', userId: 'dsmdesktop', summaryPrompt: '按事项、决定和待办总结当天记录。',
      keepRunningInBackground: false,
    },
    history: [],
    summaryWorkspace: {
      source: 'local', date: '2026-07-04', userId: 'dsmdesktop', category: '', startTime: '00:00', endTime: '12:45',
      maxInputChars: 24000, loading: true, error: '', saveMessage: '', result,
    },
  },
  version: 37,
}

app.on('window-all-closed', () => {})

async function createWindow() {
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false, frame: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  await win.loadURL(target)
  await win.webContents.executeJavaScript(`localStorage.setItem('asr-desktop-store', ${JSON.stringify(JSON.stringify(visualState))}); location.reload()`)
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  await win.webContents.executeJavaScript(`Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    listSummaryLogs: async () => [
      { name: 'summary_2026-07-04_latest.md', path: 'G:/Amadeus/summary-logs/2026-07-04/summary_latest.md', modifiedAt: '2026-07-04T12:40:00Z', content: '# 已生成总结\\n\\n可重新加载显示。' },
      { name: 'summary_2026-07-04_morning.md', path: 'G:/Amadeus/summary-logs/2026-07-04/summary_morning.md', modifiedAt: '2026-07-04T09:10:00Z', content: '# 上午总结' }
    ],
    closeWithAction: () => undefined,
    minimize: () => undefined,
    maximize: () => undefined,
    setTheme: async () => true,
    setKeepRunningInBackground: () => undefined
  } }); true`)
  return win
}

async function captureSummary() {
  const win = await createWindow()
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.sidebar nav button')].find((item) => item.textContent?.includes('当日总结')))?.click(); true`)
  await new Promise((resolve) => setTimeout(resolve, 700))
  const file = path.join(outDir, '2026-07-04-summary-stream-history-1600x1000.png')
  await fs.writeFile(file, (await win.webContents.capturePage()).toPNG())
  win.destroy()
  return file
}

async function captureCloseChoice() {
  const win = await createWindow()
  await win.webContents.executeJavaScript(`document.querySelector('.window-actions .danger')?.click()`)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const file = path.join(outDir, '2026-07-04-close-choice-1600x1000.png')
  await fs.writeFile(file, (await win.webContents.capturePage()).toPNG())
  win.destroy()
  return file
}

app.whenReady().then(async () => {
  try {
    await fs.mkdir(outDir, { recursive: true })
    // Warm Chromium/Vite with the simple modal capture first; the summary page
    // is captured second after renderer assets are fully cached.
    const closeChoice = await captureCloseChoice()
    const summary = await captureSummary()
    console.log(JSON.stringify([summary, closeChoice], null, 2))
  } finally {
    app.quit()
  }
})
