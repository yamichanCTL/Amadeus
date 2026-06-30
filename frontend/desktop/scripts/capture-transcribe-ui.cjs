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

const target = process.argv[2] || 'http://127.0.0.1:5174/'
const outDir = process.argv[3] || path.resolve(process.cwd(), '../../tmp/ui-screenshots')

async function capture(width, height, name) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
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
        }
      },
      version: 33
    }))
    location.reload()
  `)
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  await win.webContents.executeJavaScript(`document.querySelectorAll('.sidebar button')[2]?.click()`)
  await new Promise((resolve) => setTimeout(resolve, 450))
  const image = await win.webContents.capturePage()
  const file = path.join(outDir, name)
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(file, image.toPNG())
  win.destroy()
  return file
}

app.whenReady().then(async () => {
  try {
    const files = [
      await capture(1366, 900, 'transcribe-1366x900.png'),
      await capture(760, 720, 'transcribe-760x720.png'),
    ]
    console.log(files.join('\n'))
  } finally {
    app.quit()
  }
})
