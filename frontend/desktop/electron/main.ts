import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
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
import { runAmadeusWindowsE2E } from './e2e'

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

function resolveAssetPath(relativePath: string): string {
  // In production, extraResources land in process.resourcesPath.
  // In development, __dirname is dist-electron/ so walk up to the repo root.
  if (isDev) {
    return path.join(__dirname, '..', '..', '..', relativePath)
  }
  return path.join(process.resourcesPath, relativePath)
}

function loadAppIcon(): Electron.NativeImage | undefined {
  const iconPath = resolveAssetPath('img/Amadeus/amadeus.jpg')
  try {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) return icon
  } catch {
    // fall through
  }
  return undefined
}
const isE2EMode = process.argv.includes('--amadeus-e2e')
const e2eUserData = process.argv.find((arg) => arg.startsWith('--amadeus-e2e-user-data='))?.slice('--amadeus-e2e-user-data='.length)

let mainWindow: BrowserWindow | null = null
let statusOverlay: BrowserWindow | null = null
let captionOverlay: BrowserWindow | null = null
let tray: Tray | null = null
let forceQuit = false
let mouseHook: ChildProcessWithoutNullStreams | null = null
let keyboardHook: ChildProcessWithoutNullStreams | null = null
let registeredHotkey = ''
let lastTriggerAt = 0
let captionCloseRequestCount = 0
let captionSettingsRequestCount = 0

app.setName('Amadeus')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function emitHotkeyTriggered() {
  const now = Date.now()
  if (now - lastTriggerAt < 250) return
  lastTriggerAt = now
  mainWindow?.webContents.send('hotkey:triggered')
}

if (isE2EMode && e2eUserData) {
  app.setPath('userData', path.resolve(e2eUserData))
} else if (isDev) {
  app.setPath('userData', path.join(os.tmpdir(), 'amadeus-desktop-dev'))
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
  const windowIcon = loadAppIcon()

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 560,
    minHeight: 460,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#f3f3f3',
    show: false,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (registeredHotkey === 'AltRight' && input.type === 'keyDown' && input.code === 'AltRight' && !input.isAutoRepeat) {
      emitHotkeyTriggered()
    }
  })

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(
      path.join(__dirname, '..', 'dist', 'index.html'),
      isE2EMode ? { query: { e2e: '1' } } : undefined
    )
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

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
      title: '关闭 Amadeus',
      message: '要让 Amadeus 继续在后台运行吗？'
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

  if (isE2EMode) {
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media')
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'media'))
  }

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    callback({ video: sources[0], audio: 'loopback' })
  })
}

let liveCaptionActive = false

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: liveCaptionActive ? '停止实时识别' : '开启实时识别',
      click: () => mainWindow?.webContents.send('liveCaption:trayToggle')
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        forceQuit = true
        app.quit()
      }
    }
  ])
}

function createTray() {
  if (!isWindows) return

  const trayIcon = (() => {
    const icon = loadAppIcon()
    if (icon) {
      try { return icon.resize({ width: 16, height: 16 }) } catch { /* fall through */ }
    }
    return nativeImage.createEmpty()
  })()
  tray = new Tray(trayIcon)
  tray.setToolTip('Amadeus')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', showMainWindow)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
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
    webPreferences: kind === 'caption'
      ? {
          preload: path.join(__dirname, 'overlay-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false
        }
      : { sandbox: true }
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  return overlay
}

function overlayHtml(body: string) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`
}

function statusOverlayHtml() {
  return `
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; overflow: hidden; font-family: "Segoe UI", sans-serif; color: white; }
      .box { width: 100vw; height: 100vh; display: grid; grid-template-columns: 78px minmax(0, 1fr); align-items: center; gap: 16px; padding: 12px 18px; background: rgba(14, 22, 35, .9); border: 1px solid rgba(255,255,255,.2); border-radius: 18px; box-shadow: 0 18px 52px rgba(0,0,0,.3); }
      .wave { height: 42px; display: flex; align-items: center; justify-content: center; gap: 4px; }
      .wave i { width: 5px; height: calc(7px + var(--level, 0) * var(--scale, 20px)); border-radius: 99px; background: linear-gradient(180deg, #9fb7ff, #5a7cff); transition: height 70ms linear; }
      .wave i:nth-child(2), .wave i:nth-child(6) { --scale: 27px; }
      .wave i:nth-child(3), .wave i:nth-child(5) { --scale: 34px; }
      .wave i:nth-child(4) { --scale: 40px; }
      .copy { min-width: 0; display: grid; gap: 3px; }
      strong { font-size: 15px; letter-spacing: .2px; }
      small { color: rgba(235,241,255,.72); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .thinking .wave i { animation: think-wave 900ms ease-in-out infinite; }
      .thinking .wave i:nth-child(2n) { animation-delay: 120ms; }
      .error .wave i { background: #ff8b82; }
      @keyframes think-wave { 0%, 100% { height: 8px; opacity: .55; } 50% { height: 30px; opacity: 1; } }
    </style>
    <div class="box" id="box">
      <div class="wave" id="wave">${Array.from({ length: 7 }, () => '<i></i>').join('')}</div>
      <div class="copy"><strong id="title">语音输入中</strong><small id="detail">正在检测麦克风输入</small></div>
    </div>
    <script>
      (() => {
        const box = document.getElementById('box');
        const wave = document.getElementById('wave');
        const title = document.getElementById('title');
        const detail = document.getElementById('detail');
        let phase = 'recording';
        let dots = 1;
        setInterval(() => {
          if (phase !== 'thinking') return;
          dots = dots % 3 + 1;
          title.textContent = 'thinking' + '.'.repeat(dots);
        }, 420);
        window.amadeusStatus = {
          update(nextPhase, rawLevel, message) {
            phase = nextPhase || 'recording';
            box.className = 'box ' + phase;
            const level = Math.max(0, Math.min(1, Number(rawLevel) || 0));
            wave.style.setProperty('--level', String(Math.max(.08, Math.sqrt(level))));
            if (phase === 'recording') {
              title.textContent = '语音输入中';
              detail.textContent = level > .012 ? '麦克风输入正常' : '等待声音，请检查输入设备';
            } else if (phase === 'thinking') {
              title.textContent = 'thinking.';
              detail.textContent = message || '正在识别并整理文本';
            } else {
              title.textContent = '识别异常';
              detail.textContent = message || '可在 Amadeus 中强制停止';
            }
          }
        };
      })();
    </script>`
}

async function showStatusOverlay(status: string, level = 0, message = '') {
  if (!isWindows) return false
  const workArea = screen.getPrimaryDisplay().workArea
  const width = 340
  const height = 82
  if (!statusOverlay || statusOverlay.isDestroyed()) {
    statusOverlay = createOverlayWindow('status', {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + workArea.height * .72 - height / 2),
      width,
      height
    })
    await statusOverlay.loadURL(overlayHtml(statusOverlayHtml()))
  }
  const phase = status === 'recording' ? 'recording' : status === 'error' ? 'error' : 'thinking'
  await statusOverlay.webContents.executeJavaScript(
    `window.amadeusStatus?.update(${JSON.stringify(phase)}, ${Number(level) || 0}, ${JSON.stringify(message)})`
  )
  statusOverlay.showInactive()
  return true
}

function captionOverlayHtml() {
  return `
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; overflow: hidden; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; color: white; }
      .caption { position: relative; width: 100vw; height: 100vh; display: grid; place-items: center; padding: 26px 54px 18px 28px; border-radius: 10px; border: 1px solid rgba(255,255,255,.18); }
      .text { width: 100%; line-height: 1.45; text-align: center; word-break: break-word; white-space: pre-wrap; }
      .actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 5px; }
      button { width: 30px; height: 28px; border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: rgba(15,23,42,.58); color: white; cursor: pointer; }
      button:hover { background: rgba(68,84,112,.88); }
    </style>
    <div class="caption" id="caption">
      <div class="actions"><button id="settings" title="字幕设置">⚙</button><button id="close" title="关闭字幕">×</button></div>
      <div class="text" id="text">正在聆听…</div>
    </div>
    <script>
      document.getElementById('settings').addEventListener('click', () => window.captionOverlay?.openSettings());
      document.getElementById('close').addEventListener('click', () => window.captionOverlay?.close());
      window.setCaption = (text, options) => {
        const caption = document.getElementById('caption');
        const content = document.getElementById('text');
        document.body.style.color = options.color;
        caption.style.background = 'rgba(12,18,24,' + options.backgroundOpacity + ')';
        content.style.fontSize = options.fontSize + 'px';
        content.textContent = text || '正在聆听…';
      };
    </script>`
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
    await captionOverlay.loadURL(overlayHtml(captionOverlayHtml()))
  }
  captionOverlay.setBounds({ x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height })
  await captionOverlay.webContents.executeJavaScript(
    `window.setCaption?.(${JSON.stringify(text || '正在聆听…')}, ${JSON.stringify(options)})`
  )
  captionOverlay.showInactive()
  return true
}

function stopMouseHook() {
  if (!mouseHook) return
  mouseHook.kill()
  mouseHook = null
}

function stopKeyboardHook() {
  if (!keyboardHook) return
  keyboardHook.kill()
  keyboardHook = null
}

function startRightAltHook() {
  stopKeyboardHook()
  // Electron accelerators cannot represent a standalone right-side modifier.
  // On Windows, poll VK_RMENU so the trigger remains global and preserves left/right identity.
  if (!isWindows) return true
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KeyboardState {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@
$last = $false
while ($true) {
  $down = ([KeyboardState]::GetAsyncKeyState(0xA5) -band 0x8000) -ne 0
  if ($down -and -not $last) { Write-Output "AltRight" }
  $last = $down
  Start-Sleep -Milliseconds 35
}`
  keyboardHook = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
  keyboardHook.stdout.on('data', (chunk) => {
    if (chunk.toString().split(/\r?\n/).some((item: string) => item.trim() === 'AltRight')) {
      emitHotkeyTriggered()
    }
  })
  keyboardHook.on('exit', () => { keyboardHook = null })
  return true
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
    if (names.includes(watched)) emitHotkeyTriggered()
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

async function readUserId() {
  try {
    return (await fs.readFile(path.join(await defaultArchiveDir(), 'userid'), 'utf8')).trim()
  } catch {
    return ''
  }
}

async function writeUserId(rawUserId: string) {
  const userId = String(rawUserId || '').trim().replace(/[\r\n\0]/g, '').slice(0, 128)
  const target = path.join(await defaultArchiveDir(), 'userid')
  await fs.writeFile(target, userId, 'utf8')
  return { userId, path: target }
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

async function injectText(text: string) {
  clipboard.writeText(text)
  if (!isWindows) return false
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AmadeusPaste {
  [DllImport("user32.dll", SetLastError=true)] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Paste() {
    keybd_event(0x11, 0, 0, UIntPtr.Zero);
    keybd_event(0x56, 0, 0, UIntPtr.Zero);
    keybd_event(0x56, 0, 2, UIntPtr.Zero);
    keybd_event(0x11, 0, 2, UIntPtr.Zero);
  }
}
"@
Start-Sleep -Milliseconds 90
[AmadeusPaste]::Paste()
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
    const timer = setTimeout(() => { child.kill(); reject(new Error('文本注入超时，文本已保留在剪贴板')) }, 3000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`文本注入失败 (${code ?? 'unknown'})，文本已保留在剪贴板`))
    })
  })
  return true
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
  ipcMain.handle('app:userId:get', readUserId)
  ipcMain.handle('app:userId:set', (_event, userId: string) => writeUserId(userId))
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
    if (isE2EMode) return true
    if (registeredHotkey && registeredHotkey !== 'AltRight') globalShortcut.unregister(registeredHotkey)
    stopKeyboardHook()
    registeredHotkey = accelerator
    if (accelerator === 'AltRight') return startRightAltHook()
    return globalShortcut.register(accelerator, emitHotkeyTriggered)
  })
  ipcMain.handle('hotkey:unregister', () => {
    if (registeredHotkey && registeredHotkey !== 'AltRight') globalShortcut.unregister(registeredHotkey)
    stopKeyboardHook()
    registeredHotkey = ''
    return true
  })
  ipcMain.handle('mouse:register', (_event, button: string) => isE2EMode ? true : startMouseHook(button))
  ipcMain.handle('mouse:unregister', () => {
    stopMouseHook()
    return true
  })
  ipcMain.handle('text:toClipboard', (_event, text: string) => {
    clipboard.writeText(text)
    return true
  })
  ipcMain.handle('text:inject', (_event, text: string) => injectText(text))
  ipcMain.handle('statusOverlay:show', (_event, status: string, level?: number, message?: string) => showStatusOverlay(status, level, message))
  ipcMain.handle('statusOverlay:hide', () => {
    statusOverlay?.hide()
    return true
  })
  ipcMain.handle('captionOverlay:show', (_event, text: string, options: CaptionOverlayOptions) => showCaptionOverlay(text, options))
  ipcMain.handle('captionOverlay:hide', () => {
    captionOverlay?.hide()
    return true
  })
  ipcMain.on('captionOverlay:closeRequested', () => {
    captionCloseRequestCount += 1
    captionOverlay?.hide()
    mainWindow?.webContents.send('captionOverlay:closedByUser')
  })
  ipcMain.on('captionOverlay:settingsRequested', () => {
    captionSettingsRequestCount += 1
    showMainWindow()
    mainWindow?.webContents.send('captionOverlay:settingsRequested')
  })
  ipcMain.handle('app:autoLaunch:get', () => {
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('app:autoLaunch:set', (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return true
  })
  ipcMain.on('liveCaption:stateChanged', (_event, active: boolean) => {
    liveCaptionActive = active
    if (tray && !tray.isDestroyed()) {
      tray.setContextMenu(buildTrayMenu())
    }
  })
}

const gotLock = isE2EMode || app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', showMainWindow)

app.whenReady().then(() => {
  configureDisplayMediaCapture()
  registerIpc()
  createWindow()
  if (!isE2EMode) createTray()

  if (isE2EMode && mainWindow) {
    const testMainWindow = mainWindow
    const run = async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 700))
        await runAmadeusWindowsE2E({
          mainWindow: testMainWindow,
          showStatusOverlay,
          getStatusOverlay: () => statusOverlay,
          showCaptionOverlay,
          getCaptionOverlay: () => captionOverlay,
          injectText,
          writeUserId,
          readUserId,
          getCaptionRequestCounts: () => ({
            close: captionCloseRequestCount,
            settings: captionSettingsRequestCount
          })
        })
      } catch (error) {
        const dir = path.join(app.getPath('userData'), 'e2e')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(
          path.join(dir, 'fatal.json'),
          JSON.stringify({ error: error instanceof Error ? error.stack || error.message : String(error) }, null, 2),
          'utf8'
        )
      } finally {
        forceQuit = true
        setTimeout(() => app.quit(), 400)
      }
    }
    if (testMainWindow.webContents.isLoading()) testMainWindow.webContents.once('did-finish-load', () => void run())
    else void run()
  }

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
  stopKeyboardHook()
  tray?.destroy()
})
