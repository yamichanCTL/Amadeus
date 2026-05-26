import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  session,
  shell,
  Tray
} from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

type ClosePreference = 'ask' | 'background' | 'quit'

type CaptionOverlayOptions = {
  fontSize: number
  color: string
  backgroundOpacity: number
  width: number
  height: number
  x: number | null
  y: number | null
}

type ArchiveArgs = {
  archiveRoot?: string
  taskId: string
  filename: string
  audioBase64?: string
  audioExtension?: string
  metadata: Record<string, unknown>
}

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const isWindows = process.platform === 'win32'

let mainWindow: BrowserWindow | null = null
let statusOverlay: BrowserWindow | null = null
let captionOverlay: BrowserWindow | null = null
let tray: Tray | null = null
let forceQuit = false
let mouseHook: ChildProcessWithoutNullStreams | null = null
let registeredHotkey = ''

if (isDev) {
  app.setPath('userData', path.join(os.tmpdir(), 'asr-desktop-dev'))
}

const prefPath = () => path.join(app.getPath('userData'), 'preferences.json')

async function readClosePreference(): Promise<ClosePreference> {
  try {
    const raw = await fs.readFile(prefPath(), 'utf8')
    const parsed = JSON.parse(raw) as { closePreference?: ClosePreference }
    return parsed.closePreference ?? 'ask'
  } catch {
    return 'ask'
  }
}

async function writeClosePreference(closePreference: ClosePreference) {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(prefPath(), JSON.stringify({ closePreference }, null, 2), 'utf8')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#f3f3f3',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.on('close', async (event) => {
    if (!isWindows || forceQuit) return

    const preference = await readClosePreference()
    if (preference === 'background') {
      event.preventDefault()
      mainWindow?.hide()
      return
    }
    if (preference === 'quit') {
      forceQuit = true
      return
    }

    event.preventDefault()
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      buttons: ['后台运行', '退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: '记住我的选择',
      title: '关闭 ASR Desktop',
      message: '要将 ASR Desktop 保持在后台运行吗？'
    })

    if (result.checkboxChecked && result.response !== 2) {
      await writeClosePreference(result.response === 0 ? 'background' : 'quit')
    }

    if (result.response === 0) {
      mainWindow?.hide()
    } else if (result.response === 1) {
      forceQuit = true
      app.quit()
    }
  })
}

function configureDisplayMediaCapture() {
  if (!isWindows) return

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    callback({ video: sources[0], audio: 'loopback' })
  })
}

function createTray() {
  if (!isWindows) return

  tray = new Tray(path.join(process.execPath))
  tray.setToolTip('ASR Desktop')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          forceQuit = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', showMainWindow)
}

function showMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function sanitizeCaptionOptions(options: CaptionOverlayOptions): CaptionOverlayOptions {
  const workArea = screen.getPrimaryDisplay().workArea
  const width = clamp(Number(options.width) || 760, 320, Math.min(1200, workArea.width))
  const height = clamp(Number(options.height) || 150, 96, Math.min(500, workArea.height))
  const x = options.x == null ? Math.round(workArea.x + (workArea.width - width) / 2) : clamp(options.x, workArea.x, workArea.x + workArea.width - width)
  const y = options.y == null ? workArea.y + workArea.height - height - 80 : clamp(options.y, workArea.y, workArea.y + workArea.height - height)

  return {
    fontSize: clamp(Number(options.fontSize) || 20, 12, 48),
    color: options.color || '#ffffff',
    backgroundOpacity: clamp(Number(options.backgroundOpacity) || 0.86, 0, 1),
    width,
    height,
    x,
    y
  }
}

function createOverlayWindow(kind: 'status' | 'caption', bounds: Electron.Rectangle) {
  const overlay = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: kind === 'caption',
    movable: kind === 'caption',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: kind === 'caption',
    webPreferences: {
      sandbox: true
    }
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  return overlay
}

function overlayHtml(body: string) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`
}

async function showStatusOverlay(status: string) {
  if (!isWindows) return false
  const workArea = screen.getPrimaryDisplay().workArea
  const width = 220
  const height = 48
  if (!statusOverlay || statusOverlay.isDestroyed()) {
    statusOverlay = createOverlayWindow('status', {
      x: workArea.x + workArea.width - width - 24,
      y: workArea.y + 24,
      width,
      height
    })
  }
  await statusOverlay.loadURL(
    overlayHtml(`
      <style>
        body { margin: 0; font-family: "Segoe UI", sans-serif; color: white; }
        .box { box-sizing: border-box; width: 100vw; height: 100vh; padding: 0 18px; display: flex; align-items: center; justify-content: center; background: rgba(20, 31, 43, .88); border: 1px solid rgba(255,255,255,.22); border-radius: 10px; }
      </style>
      <div class="box">${status === 'recording' ? '语音输入中' : '转写中'}</div>
    `)
  )
  statusOverlay.showInactive()
  return true
}

async function showCaptionOverlay(text: string, rawOptions: CaptionOverlayOptions) {
  if (!isWindows) return false
  const options = sanitizeCaptionOptions(rawOptions)
  if (!captionOverlay || captionOverlay.isDestroyed()) {
    captionOverlay = createOverlayWindow('caption', {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width,
      height: options.height
    })
    captionOverlay.on('close', () => mainWindow?.webContents.send('captionOverlay:closedByUser'))
    captionOverlay.on('moved', () => {
      const bounds = captionOverlay?.getBounds()
      if (bounds) mainWindow?.webContents.send('captionOverlay:styleChanged', bounds)
    })
    captionOverlay.on('resized', () => {
      const bounds = captionOverlay?.getBounds()
      if (bounds) mainWindow?.webContents.send('captionOverlay:styleChanged', bounds)
    })
  }
  captionOverlay.setBounds({ x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height })
  await captionOverlay.loadURL(
    overlayHtml(`
      <style>
        body { margin: 0; overflow: hidden; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; color: ${options.color}; }
        .caption { box-sizing: border-box; width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; padding: 18px 28px; background: rgba(12, 18, 24, ${options.backgroundOpacity}); border-radius: 8px; border: 1px solid rgba(255,255,255,.18); }
        .text { width: 100%; line-height: 1.45; font-size: ${options.fontSize}px; text-align: center; word-break: break-word; }
      </style>
      <div class="caption"><div class="text">${escapeHtml(text || '正在聆听...')}</div></div>
    `)
  )
  captionOverlay.show()
  return true
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

function stopMouseHook() {
  if (!mouseHook) return
  mouseHook.kill()
  mouseHook = null
}

function startMouseHook(button: string) {
  stopMouseHook()
  if (!isWindows) return false

  const watched = button.toLowerCase()
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$last = ""
while ($true) {
  $state = ""
  if ([System.Windows.Forms.Control]::MouseButtons -band [System.Windows.Forms.MouseButtons]::Left) { $state = "mouse_left" }
  elseif ([System.Windows.Forms.Control]::MouseButtons -band [System.Windows.Forms.MouseButtons]::Right) { $state = "mouse_right" }
  elseif ([System.Windows.Forms.Control]::MouseButtons -band [System.Windows.Forms.MouseButtons]::Middle) { $state = "mouse_middle" }
  elseif ([System.Windows.Forms.Control]::MouseButtons -band [System.Windows.Forms.MouseButtons]::XButton1) { $state = "mouse_x1" }
  elseif ([System.Windows.Forms.Control]::MouseButtons -band [System.Windows.Forms.MouseButtons]::XButton2) { $state = "mouse_x2" }
  if ($state -ne "" -and $state -ne $last) { Write-Output $state }
  $last = $state
  Start-Sleep -Milliseconds 90
}`

  mouseHook = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
  mouseHook.stdout.on('data', (chunk) => {
    const names = chunk.toString().split(/\r?\n/).map((item: string) => item.trim()).filter(Boolean)
    if (names.includes(watched)) mainWindow?.webContents.send('hotkey:triggered')
  })
  mouseHook.on('exit', () => {
    mouseHook = null
  })
  return true
}

async function defaultArchiveDir() {
  const dir = path.join(app.getPath('userData'), 'archive')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function safeStem(filename: string) {
  const parsed = path.parse(filename)
  return parsed.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'audio'
}

async function archiveTranscription(args: ArchiveArgs) {
  const root = args.archiveRoot || (await defaultArchiveDir())
  const day = new Date().toISOString().slice(0, 10)
  const dir = path.join(root, day)
  await fs.mkdir(dir, { recursive: true })

  const stem = `${args.taskId}_${safeStem(args.filename)}`
  const paths: { audio?: string; json: string } = { json: path.join(dir, `${stem}.json`) }

  if (args.audioBase64) {
    const ext = args.audioExtension || path.extname(args.filename) || '.webm'
    paths.audio = path.join(dir, `${stem}${ext}`)
    await fs.writeFile(paths.audio, Buffer.from(args.audioBase64, 'base64'))
  }

  await fs.writeFile(paths.json, JSON.stringify({ archived_at: new Date().toISOString(), ...args.metadata }, null, 2), 'utf8')
  return paths
}

function registerIpc() {
  ipcMain.on('win:minimize', () => mainWindow?.minimize())
  ipcMain.on('win:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('win:close', () => mainWindow?.close())

  ipcMain.handle('dialog:openAudio', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'webm'] }]
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? '' : result.filePaths[0]
  })
  ipcMain.handle('app:defaultArchiveDir', defaultArchiveDir)
  ipcMain.handle('dialog:saveFile', async (_event, name: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: name })
    return result.canceled ? '' : result.filePath
  })
  ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string) => {
    await fs.writeFile(filePath, content, 'utf8')
    return true
  })
  ipcMain.handle('fs:readFileBase64', async (_event, filePath: string) => (await fs.readFile(filePath)).toString('base64'))
  ipcMain.handle('fs:fileInfo', async (_event, filePath: string) => {
    const stats = await fs.stat(filePath)
    return { name: path.basename(filePath), size: stats.size, path: filePath }
  })
  ipcMain.handle('archive:transcription', (_event, args: ArchiveArgs) => archiveTranscription(args))
  ipcMain.handle('shell:openExternal', (_event, url: string) => shell.openExternal(url))
  ipcMain.handle('theme:get', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
  ipcMain.handle('theme:set', (_event, theme: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = theme
    return true
  })
  ipcMain.handle('hotkey:register', (_event, accelerator: string) => {
    if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
    registeredHotkey = accelerator
    return globalShortcut.register(accelerator, () => mainWindow?.webContents.send('hotkey:triggered'))
  })
  ipcMain.handle('hotkey:unregister', () => {
    if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
    registeredHotkey = ''
    return true
  })
  ipcMain.handle('mouse:register', (_event, button: string) => startMouseHook(button))
  ipcMain.handle('mouse:unregister', () => {
    stopMouseHook()
    return true
  })
  ipcMain.handle('text:toClipboard', (_event, text: string) => {
    clipboard.writeText(text)
    return true
  })
  ipcMain.handle('text:inject', (_event, text: string) => {
    clipboard.writeText(text)
    if (!isWindows || mainWindow?.isFocused()) return true
    spawn('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")'], { windowsHide: true })
    return true
  })
  ipcMain.handle('statusOverlay:show', (_event, status: string) => showStatusOverlay(status))
  ipcMain.handle('statusOverlay:hide', () => {
    statusOverlay?.hide()
    return true
  })
  ipcMain.handle('captionOverlay:show', (_event, text: string, options: CaptionOverlayOptions) => showCaptionOverlay(text, options))
  ipcMain.handle('captionOverlay:hide', () => {
    captionOverlay?.hide()
    return true
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', showMainWindow)

app.whenReady().then(() => {
  configureDisplayMediaCapture()
  registerIpc()
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopMouseHook()
  tray?.destroy()
})
