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

const targetIndex = process.argv.findIndex((arg) => /^https?:\/\//.test(arg))
const target = targetIndex >= 0 ? process.argv[targetIndex] : 'http://127.0.0.1:5174/'
const outDir = targetIndex >= 0 && process.argv[targetIndex + 1]
  ? process.argv[targetIndex + 1]
  : path.resolve(process.cwd(), '../../tmp/ui-screenshots')
let sharedWindow = null

async function capture(width, height, name, pageIndex = 2) {
  const win = sharedWindow || new BrowserWindow({
    width: 1366,
    height: 900,
    show: false,
    frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  if (!sharedWindow) {
    sharedWindow = win
    await win.loadURL(target)
    await win.webContents.executeJavaScript(`
    localStorage.setItem('asr-desktop-store', JSON.stringify({
      state: {
        settings: {
          serverUrl: '',
          backendConfirmed: false,
          offlineEngine: 'sensevoice',
          streamingEngine: 'x-asr',
          defaultLanguage: 'zh',
          whisperModel: 'base',
          enablePunctuation: false,
          theme: 'windows',
          inputSource: 'file',
          liveCaptionEnabled: false,
          showDesktopCaptions: true,
          liveCaptionChunkSec: 4,
          captionFontSize: 20,
          captionFontColor: '#ffffff',
          captionBackgroundOpacity: 0.86,
          captionBoxWidth: 760,
          captionBoxHeight: 150,
          captionBoxX: null,
          captionBoxY: null,
          triggerType: 'keyboard',
          triggerKey: 'AltRight',
          injectMode: 'inject',
          timeoutSec: 20,
          allowServerDataCollection: false,
          archiveDir: '',
          audioInputDeviceId: '',
          audioOutputDeviceId: '',
          llmBaseUrl: 'https://api.deepseek.com',
          llmProvider: 'deepseek',
          llmModel: 'deepseek-chat',
          llmApiToken: '',
          llmTargetLanguage: 'English',
          llmStyle: '',
          llmPolishPrompt: '请润色以下离线语音识别结果：修正错别字、标点和不自然表达，保持原意，不添加新事实，只返回润色后的文本。',
          llmAutoPolish: true,
          llmAutoTranslate: false
        },
        history: Array.from({ length: 8 }, (_, index) => ({
          id: 'visual-' + index,
          task_id: 'visual-' + index,
          status: 'success',
          full_text: '这是一条用于验证不同分辨率下历史列表与详情面板不会互相覆盖的识别结果。',
          language: 'zh',
          engine_used: 'fireredasr2',
          confidence: 0.96,
          duration_sec: 2.6,
          elapsed_sec: 0.4,
          segments: [],
          llm_outputs: { polish: { text: '这是润色后的测试结果。', operation: 'polish', model: 'visual-model', elapsed_sec: 0.1 } },
          created_at: new Date(Date.now() - index * 60000).toISOString(),
          filename: 'recording_responsive_layout_' + index + '.webm'
        }))
      },
      version: 34
    }))
    location.reload()
    `)
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  }
  win.setSize(width, height)
  await win.webContents.executeJavaScript(`document.querySelectorAll('.sidebar button')[${pageIndex}]?.click()`)
  await new Promise((resolve) => setTimeout(resolve, 450))
  const layout = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('.history-list')?.getBoundingClientRect()
    const detail = document.querySelector('.history-detail')?.getBoundingClientRect()
    const overlaps = Boolean(list && detail
      && list.left < detail.right && list.right > detail.left
      && list.top < detail.bottom && list.bottom > detail.top)
    return {
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      overlaps,
      columns: document.querySelector('.history-workspace')
        ? getComputedStyle(document.querySelector('.history-workspace')).gridTemplateColumns
        : null
    }
  })()`)
  const image = await win.webContents.capturePage()
  const file = path.join(outDir, name)
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(file, image.toPNG())
  return { file, layout }
}

app.whenReady().then(async () => {
  try {
    const reports = [
      await capture(1366, 900, 'transcribe-1366x900.png'),
      await capture(760, 720, 'transcribe-760x720.png'),
      await capture(1280, 720, 'history-1280x720.png', 3),
      await capture(1280, 960, 'history-1280x960.png', 3),
      await capture(720, 520, 'history-720x520.png', 3),
    ]
    console.log(JSON.stringify(reports, null, 2))
    const failed = reports.some(({ layout }) => layout.scrollWidth !== layout.width || layout.overlaps)
    if (failed) process.exitCode = 1
  } finally {
    sharedWindow?.destroy()
    app.quit()
  }
})
