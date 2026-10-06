import {
  app,
  BrowserWindow,
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
import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createInterface } from 'node:readline'
import { runAmadeusWindowsE2E } from './e2e'
import { LatestTaskQueue } from './latest-task-queue'
import { runTextInjectionWithRecovery, TextInjectionCancelledError, TextInjectionNotSentError } from './text-inject-retry'
import { textInjectHelperScript, textInjectionFailure } from './text-inject-helper'
import { closeAction } from './close-behavior'
import { calculateInitialWindowBounds } from './window-layout'
import { localArchiveDay, safeArchiveStem, writeTranscriptionArchive } from './archive-layout'
import { listSummaryLogs } from './summary-log-layout'
import { extractAudioForUpload } from './media-upload'
import { sanitizePetAudioFrame, type PetAudioFrame } from './pet-audio'
import { LocalRuntimeManager, type LocalRuntimeState } from './local-runtime'
import { LocalAvatarStore } from './local-avatar'
import { acquireAppInstanceLock } from './single-instance'
import { StorageLayout, type StorageState } from './storage-layout'
import { WarmOverlay } from './warm-overlay'

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
  archiveCategory?: string
  taskId: string
  filename: string
  audioBase64?: string
  audioExtension?: string
  metadata: Record<string, unknown>
}

type SummaryLogArgs = {
  archiveRoot?: string
  date: string
  filename?: string
  content: string
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
  for (const relativePath of ['img/Amadeus/amadeus-icon.png', 'img/Amadeus/amadeus.ico', 'img/Amadeus/amadeus.jpg']) {
    try {
      const icon = nativeImage.createFromPath(resolveAssetPath(relativePath))
      if (!icon.isEmpty()) return icon
    } catch {
      // try the next format
    }
  }
  return undefined
}
const isE2EMode = process.argv.includes('--amadeus-e2e')
const isUninstallDataMode = process.argv.includes('--amadeus-uninstall-data')
if (isE2EMode) app.commandLine.appendSwitch('force-renderer-accessibility')
const e2eUserData = process.argv.find((arg) => arg.startsWith('--amadeus-e2e-user-data='))?.slice('--amadeus-e2e-user-data='.length)
const previewUserData = process.argv.find((arg) => arg.startsWith('--amadeus-preview-user-data='))?.slice('--amadeus-preview-user-data='.length)

let mainWindow: BrowserWindow | null = null
let mainWindowReady = false
let pendingMainWindowActivation = false
let statusOverlay: BrowserWindow | null = null
let captionOverlay: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let lastPetAudioFrame: PetAudioFrame | null = null
let petEnabled = false
let petDragging: { cursor: Electron.Point; position: number[] } | null = null
let petMouseIgnored = true
let petPositionSaveTimer: ReturnType<typeof setTimeout> | null = null
let petState: Record<string, string> = { status: 'idle', emotion: 'neutral', action: 'idle', reply: '', error: '' }
// User-dragged position of the status overlay, kept across phase transitions
// within a session so recording→thinking→result don't snap back to center.
let statusOverlayPos: { x: number; y: number } | null = null
let tray: Tray | null = null
let forceQuit = false
let localRuntime: LocalRuntimeManager | null = null
let localAvatar: LocalAvatarStore | null = null
let storageLayout: StorageLayout | null = null
let storageBusy = false
let runtimeQuitFinished = false
let runtimeQuitPending = false
let keepRunningInBackground = false
let mouseHook: ChildProcessWithoutNullStreams | null = null
let keyboardHook: ChildProcessWithoutNullStreams | null = null
let textInjectHelper: ChildProcessWithoutNullStreams | null = null
let textInjectHelperReady: Promise<boolean> | null = null
let settleTextInjectHelperReady: ((ready: boolean) => void) | null = null
let textInjectPending: {
  operation: 'capture' | 'inject'
  helper: ChildProcessWithoutNullStreams
  resolve: (value: boolean) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  stderr: string[]
} | null = null
const textInjectQueue = new LatestTaskQueue<boolean>(() => stopTextInjectHelper())
let lastTextTargetHwnd = '0'
let lastTextTargetProcessId = 0
let registeredHotkey = ''
let lastTriggerAt = 0
let captionCloseRequestCount = 0
let captionSettingsRequestCount = 0
let statusCancelRequestCount = 0
let statusSubmitRequestCount = 0
const TEXT_INJECT_TIMEOUT_MS = 1_500
// Add-Type/UIA initialization is prewarmed in the background. Under load it
// may exceed 1.5s; a longer bounded handshake prevents needless restart loops.
const TEXT_INJECT_READY_TIMEOUT_MS = 5_000
const textInjectDebugEvents: string[] = []

app.setName('Amadeus')
if (isWindows) app.setAppUserModelId('com.asrapp.desktop')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Acquire before any preview, test or development profile changes the data path.
const gotInstanceLock = acquireAppInstanceLock(app)

function emitHotkeyTriggered() {
  const now = Date.now()
  if (now - lastTriggerAt < 250) return
  lastTriggerAt = now
  mainWindow?.webContents.send('hotkey:triggered')
}

if (gotInstanceLock && previewUserData) {
  app.setPath('userData', path.resolve(previewUserData))
} else if (gotInstanceLock && isE2EMode && e2eUserData) {
  app.setPath('userData', path.resolve(e2eUserData))
} else if (gotInstanceLock && isDev) {
  app.setPath('userData', path.join(os.tmpdir(), 'amadeus-desktop-dev'))
}

function createWindow() {
  const windowIcon = loadAppIcon()
  const initialBounds = calculateInitialWindowBounds(screen.getPrimaryDisplay().workArea)
  mainWindowReady = false

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 720,
    minHeight: 520,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#f3f3f3',
    show: false,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (mainWindow?.isDestroyed() !== false) return
    mainWindowReady = true
    mainWindow.show()
    if (pendingMainWindowActivation) {
      pendingMainWindowActivation = false
      showMainWindow()
    }
  })
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
      { ...(isE2EMode ? { query: { e2e: '1' } } : {}),
        ...(process.argv.includes('--amadeus-realtime') ? { hash: 'realtime' } : {}) }
    )
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    mainWindowReady = false
  })

  mainWindow.on('close', (event) => {
    if (!isWindows || forceQuit) return
    event.preventDefault()
    if (closeAction(keepRunningInBackground) === 'hide') {
      mainWindow?.hide()
      return
    }
    forceQuit = true
    app.quit()
  })
}

function configureDisplayMediaCapture() {
  if (!isWindows) return

  const isTrustedMediaRequest = (webContents: Electron.WebContents | null, permission: string) => {
    const isMainWindow = Boolean(mainWindow && webContents && !mainWindow.isDestroyed() && webContents.id === mainWindow.webContents.id)
    return isMainWindow && (
      permission === 'media'
      || permission === 'display-capture'
      || permission === 'speaker-selection'
    )
  }

  // Chromium asks for display-capture permission before invoking the handler.
  // This must also be granted in packaged builds; limiting it to E2E made the
  // speaker option look selected while getDisplayMedia could not return audio.
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => (
    isTrustedMediaRequest(webContents, permission)
  ))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isTrustedMediaRequest(webContents, permission))
  })

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.audioRequested || !request.videoRequested) {
      callback({})
      return
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    const screenSource = sources[0]
    callback(screenSource ? { video: screenSource, audio: 'loopback' } : {})
  })
}

let liveCaptionActive = false

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showMainWindow() },
    { label: '爱弥斯桌宠', type: 'checkbox', checked: petEnabled, click: () => {
      setPetEnabled(!petEnabled)
      mainWindow?.webContents.send('pet:enabledChanged', petEnabled)
    } },
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
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) {
    pendingMainWindowActivation = true
    return
  }
  // restore() must come before show() — when the window was hidden to tray
  // it is not "minimized", so isMinimized() would return false.  restore()
  // handles both minimized and hidden-then-needs-restore edge cases.
  mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

const petPositionFile = () => path.join(app.getPath('userData'), 'aemeath-pet-position.json')

function petPosition(x: number, y: number, width: number, height: number) {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea
  return {
    x: Math.round(clamp(x, area.x - width * .45, area.x + area.width - width * .55)),
    y: Math.round(clamp(y, area.y - height * .4, area.y + area.height - height * .6))
  }
}

function savePetPosition() {
  if (!petWindow || petWindow.isDestroyed()) return
  const { x, y } = petWindow.getBounds()
  void fs.writeFile(petPositionFile(), JSON.stringify({ x, y }), 'utf8').catch(() => undefined)
}

function schedulePetPositionSave() {
  if (petPositionSaveTimer) clearTimeout(petPositionSaveTimer)
  petPositionSaveTimer = setTimeout(() => {
    petPositionSaveTimer = null
    savePetPosition()
  }, 350)
}

function applyNativePetTopmost() {
  if (!isWindows || !petWindow || petWindow.isDestroyed()) return
  const script = isDev
    ? path.join(__dirname, '..', 'electron', 'Set-PetTopmost.ps1')
    : path.join(process.resourcesPath, 'pet', 'Set-PetTopmost.ps1')
  const handle = String(petWindow.getNativeWindowHandle().readBigUInt64LE())
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-Handle', handle, '-Apply'],
    { windowsHide: true, timeout: 5000 }, (error) => {
      if (error) console.warn('Pet topmost helper:', error.message)
    })
}

function createPetWindow() {
  if (!isWindows || isE2EMode || petWindow) return
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(620, Math.max(460, Math.round(area.width * .27)))
  const height = Math.min(840, Math.max(580, Math.round(area.height * .82)))
  let x = area.x + area.width - width - 24
  let y = area.y + area.height - height - 5
  try {
    const saved = JSON.parse(readFileSync(petPositionFile(), 'utf8')) as { x?: number; y?: number }
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      x = saved.x!
      y = saved.y!
    }
  } catch { /* first launch */ }
  const position = petPosition(x, y, width, height)
  petWindow = new BrowserWindow({
    ...position, width, height, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', hasShadow: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false
    }
  })
  const window = petWindow
  petMouseIgnored = true
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setIgnoreMouseEvents(true, { forward: true })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('did-finish-load', () => window.webContents.send('pet:state', petState))
  window.once('ready-to-show', () => {
    window.showInactive()
    window.setAlwaysOnTop(true, 'screen-saver')
    applyNativePetTopmost()
  })
  window.on('close', savePetPosition)
  window.on('closed', () => {
    if (petWindow !== window) return
    petWindow = null
    if (petEnabled) {
      petEnabled = false
      mainWindow?.webContents.send('pet:enabledChanged', false)
      if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu())
    }
  })
  if (isDev) void window.loadURL(`${process.env.VITE_DEV_SERVER_URL!.replace(/\/$/, '')}/pet.html`)
  else void window.loadFile(path.join(__dirname, '..', 'dist', 'pet.html'))
}

function setPetEnabled(enabled: boolean) {
  petEnabled = Boolean(enabled) && isWindows && !isE2EMode
  if (petEnabled) createPetWindow()
  else {
    petDragging = null
    petWindow?.close()
    petWindow = null
  }
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu())
  return petEnabled
}

function registerPetIpc() {
  const fromMain = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === mainWindow?.webContents
  const fromPet = (event: Electron.IpcMainEvent) => event.sender === petWindow?.webContents
  ipcMain.handle('agent:getWorkToken', (event) => {
    if (!fromMain(event)) return ''
    try {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      return readFileSync(path.join(local, 'Amadeus', 'work-token'), 'utf8').trim()
    } catch { return '' }
  })
  ipcMain.handle('pet:setEnabled', (event, enabled: boolean) => fromMain(event) ? setPetEnabled(enabled) : false)
  ipcMain.on('pet:audioFrame', (event, raw: unknown) => {
    if (!fromMain(event)) return
    const frame = sanitizePetAudioFrame(raw)
    if (!frame || (lastPetAudioFrame && (frame.epoch < lastPetAudioFrame.epoch
      || frame.timestamp < lastPetAudioFrame.timestamp))) return
    lastPetAudioFrame = frame
    petWindow?.webContents.send('pet:audioFrame', frame)
  })
  ipcMain.on('pet:state', (event, raw: unknown) => {
    if (!fromMain(event) || !raw || typeof raw !== 'object') return
    const state = raw as Record<string, unknown>
    const valid = (value: unknown, choices: string[], fallback: string) => choices.includes(String(value)) ? String(value) : fallback
    petState = {
      status: valid(state.status, ['idle', 'listening', 'transcribing', 'thinking', 'responding', 'speaking', 'error'], 'idle'),
      emotion: valid(state.emotion, ['neutral', 'happy', 'curious', 'focused', 'surprised', 'concerned'], 'neutral'),
      action: valid(state.action, ['idle', 'listening', 'thinking', 'speaking', 'observing'], 'idle'),
      reply: typeof state.reply === 'string' ? state.reply.slice(0, 240) : '',
      error: typeof state.error === 'string' ? state.error.slice(0, 180) : '',
      gesture: valid(state.gesture, ['none', 'wave', 'dance', 'step_left', 'step_right', 'come_closer', 'step_back', 'turn_left', 'turn_right'], 'none'),
      gestureId: typeof state.gestureId === 'string' ? state.gestureId.slice(0, 80) : ''
    }
    petWindow?.webContents.send('pet:state', petState)
  })
  ipcMain.on('pet:interactive', (event, interactive: boolean) => {
    if (!fromPet(event) || !petWindow) return
    const ignore = !Boolean(interactive)
    if (ignore !== petMouseIgnored) {
      petWindow.setIgnoreMouseEvents(ignore, { forward: true })
      petMouseIgnored = ignore
    }
  })
  ipcMain.on('pet:dragStart', (event) => {
    if (fromPet(event) && petWindow) petDragging = { cursor: screen.getCursorScreenPoint(), position: petWindow.getPosition() }
  })
  ipcMain.on('pet:dragMove', (event) => {
    if (!fromPet(event) || !petWindow || !petDragging) return
    const point = screen.getCursorScreenPoint()
    const [width, height] = petWindow.getSize()
    const next = petPosition(petDragging.position[0] + point.x - petDragging.cursor.x,
      petDragging.position[1] + point.y - petDragging.cursor.y, width, height)
    petWindow.setPosition(next.x, next.y)
  })
  ipcMain.on('pet:dragEnd', (event) => { if (fromPet(event)) { petDragging = null; savePetPosition() } })
  ipcMain.on('pet:moveBy', (event, dx: number, dy: number) => {
    if (!fromPet(event) || !petWindow) return
    const [x, y] = petWindow.getPosition()
    const [width, height] = petWindow.getSize()
    const next = petPosition(x + clamp(Number(dx) || 0, -200, 200), y + clamp(Number(dy) || 0, -200, 200), width, height)
    petWindow.setPosition(next.x, next.y)
    schedulePetPositionSave()
  })
  ipcMain.on('pet:command', (event, raw: unknown) => {
    if (!fromPet(event) || !raw || typeof raw !== 'object') return
    const command = raw as { type?: string; text?: string }
    if (!['open', 'voice', 'text'].includes(command.type || '')) return
    const type = command.type as 'open' | 'voice' | 'text'
    if (type === 'open') showMainWindow()
    mainWindow?.webContents.send('pet:command', { id: Date.now(), type,
      text: type === 'text' && typeof command.text === 'string' ? command.text.trim().slice(0, 2000) : '' })
  })
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
    show: false,
    frame: false,
    transparent: true,
    resizable: kind === 'caption',
    // Both overlays are movable so the user can drag them out of the way.
    // The status overlay uses a click-through + drag-handle pattern (see
    // showStatusOverlay / statusOverlayHtml) so it stays click-through
    // everywhere except the handle, where Electron handles the drag natively
    // via -webkit-app-region: drag.
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: kind === 'caption',
    webPreferences: kind === 'caption'
      ? {
          preload: path.join(__dirname, 'overlay-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false
        }
      : {
          preload: path.join(__dirname, 'status-overlay-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false
        }
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
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { overflow: hidden; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; color: white; }
      .box { width: 100vw; height: 100vh; display: grid; grid-template-columns: 32px minmax(0, 1fr) 32px; align-items: center; gap: 6px; padding: 4px 6px; background: rgba(14, 22, 35, .9); border: 1px solid rgba(255,255,255,.2); border-radius: 999px; box-shadow: 0 8px 20px rgba(0,0,0,.28); }
      .box.result { grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 7px 9px; border-radius: 12px; }
      .wave { height: 22px; display: flex; align-items: center; justify-content: flex-start; gap: 2px; overflow: hidden; }
      .voice-content { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; }
      .wave i { flex: 0 0 2px; width: 2px; height: 3px; border-radius: 99px; background: linear-gradient(180deg, #a9beff, #5a7cff); transition: height 55ms linear; }
      .copy { min-width: 0; display: block; overflow: hidden; }
      strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; letter-spacing: 0; }
      small { display: none !important; }
      .thinking .wave i { animation: think-wave 840ms ease-in-out infinite; }
      .thinking .wave i:nth-child(3n+1) { animation-delay: 90ms; }
      .thinking .wave i:nth-child(3n+2) { animation-delay: 180ms; }
      .error .wave i { background: #ff8b82; }
      .result-text { font-size: 14px; line-height: 1.5; max-height: 52px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(235,241,255,.92); }
      .result-actions { display: flex; gap: 8px; align-items: center; }
      .result-actions button { width: 36px; height: 36px; border: 1px solid rgba(255,255,255,.25); border-radius: 10px; background: rgba(255,255,255,.12); color: white; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: background .15s; }
      .result-actions button:hover { background: rgba(255,255,255,.28); }
      .result-actions .btn-copy { width: auto; padding: 0 14px; font-size: 13px; gap: 5px; background: rgba(90,124,255,.35); border-color: rgba(90,124,255,.5); }
      .result-actions .btn-copy:hover { background: rgba(90,124,255,.55); }
      .result .voice-content, .result .wave, .result .copy { display: none; }
      .voice-action { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid rgba(255,255,255,.28); border-radius: 50%; background: rgba(255,255,255,.12); color: white; cursor: pointer; font-size: 18px; line-height: 1; }
      .voice-action:hover { background: rgba(255,255,255,.26); }
      .voice-action.cancel:hover { background: rgba(218,65,65,.7); }
      .voice-action.submit:hover { background: rgba(38,166,91,.7); }
      .thinking .voice-action.submit, .error .voice-action.submit, .result .voice-action { display: none; }
      @keyframes think-wave { 0%, 100% { height: 3px; opacity: .5; } 50% { height: 19px; opacity: 1; } }
      /* Thin native drag strip; action buttons remain interactive. */
      .drag-handle { position: absolute; left: 0; right: 0; top: 0; height: 8px; cursor: grab; pointer-events: auto; -webkit-app-region: drag; border-top-left-radius: 9px; border-top-right-radius: 9px; }
      .box.result .drag-handle { border-top-left-radius: 12px; border-top-right-radius: 12px; }
    </style>
    <div class="box" id="box">
      <div class="drag-handle" id="dragHandle" title="拖动以移动位置"></div>
      <button class="voice-action cancel" id="btnCancel" title="取消识别" aria-label="取消识别">×</button>
      <div class="voice-content">
        <div class="wave" id="wave">${Array.from({ length: 28 }, () => '<i></i>').join('')}</div>
        <div class="copy" id="copyBlock"><strong id="title">语音输入中</strong><small id="detail" style="display:none"></small></div>
      </div>
      <button class="voice-action submit" id="btnSubmit" title="提交识别" aria-label="提交识别">✓</button>
      <div class="result-text" id="resultText" style="display:none"></div>
      <div class="result-actions" id="resultActions" style="display:none">
        <button class="btn-copy" id="btnCopy" title="复制到剪贴板">📋 复制</button>
        <button id="btnClose" title="关闭">✕</button>
      </div>
    </div>
    <script>
      (() => {
        const box = document.getElementById('box');
        const wave = document.getElementById('wave');
        const copyBlock = document.getElementById('copyBlock');
        const title = document.getElementById('title');
        const detail = document.getElementById('detail');
        const resultText = document.getElementById('resultText');
        const resultActions = document.getElementById('resultActions');
        const btnCopy = document.getElementById('btnCopy');
        const btnClose = document.getElementById('btnClose');
        const btnCancel = document.getElementById('btnCancel');
        const btnSubmit = document.getElementById('btnSubmit');
        let phase = 'recording';
        let dots = 1;
        let resultTextContent = '';
        const bars = Array.from(wave.querySelectorAll('i'));
        const history = Array.from({ length: bars.length }, () => 0);

        const appendLevel = (rawLevel) => {
          const level = Math.max(0, Math.min(1, Number(rawLevel) || 0));
          history.shift();
          history.push(Math.max(.03, Math.sqrt(level)));
          bars.forEach((bar, index) => {
            bar.style.height = Math.round(3 + history[index] * 19) + 'px';
          });
        };

        setInterval(() => {
          if (phase !== 'thinking') return;
          dots = dots % 3 + 1;
          title.textContent = 'thinking' + '.'.repeat(dots);
        }, 420);

        btnCopy.addEventListener('click', () => {
          window.statusOverlay?.copyResult(resultTextContent);
        });
        btnClose.addEventListener('click', () => {
          window.statusOverlay?.closeResult();
        });
        btnCancel.addEventListener('click', () => window.statusOverlay?.cancelRecognition());
        btnSubmit.addEventListener('click', () => window.statusOverlay?.submitRecognition());

        window.amadeusStatus = {
          onCopy: null,
          onClose: null,
          update(nextPhase, rawLevel, message) {
            phase = nextPhase || 'recording';
            box.className = 'box ' + phase;

            if (phase === 'result') {
              wave.style.display = 'none';
              copyBlock.style.display = 'none';
              resultText.style.display = '';
              resultActions.style.display = '';
              resultText.textContent = message || '';
              resultTextContent = message || '';
              title.textContent = '识别完成';
            } else {
              wave.style.display = '';
              copyBlock.style.display = '';
              resultText.style.display = 'none';
              resultActions.style.display = 'none';

              if (phase === 'recording') {
                appendLevel(rawLevel);
                title.textContent = '语音输入中';
                detail.style.display = 'none';
                detail.textContent = '';
              } else if (phase === 'thinking') {
                detail.style.display = '';
                title.textContent = 'thinking.';
                detail.textContent = message || '正在识别并整理文本';
              } else {
                detail.style.display = '';
                title.textContent = '识别异常';
                detail.textContent = message || '可在 Amadeus 中强制停止';
              }
            }
          }
        };
        window.statusOverlay?.onUpdate((value) => window.amadeusStatus.update(value.phase, value.level, value.message));
      })();
    </script>`
}

function statusOverlayBounds(status: string): Electron.Rectangle {
  const workArea = screen.getPrimaryDisplay().workArea
  const width = status === 'result' ? 360 : 260
  const height = status === 'result' ? 64 : 42
  // Default centered position; if the user dragged the overlay previously,
  // reuse their position (clamped to the work area) so it doesn't jump back.
  const defaultX = Math.round(workArea.x + (workArea.width - width) / 2)
  const defaultY = Math.round(workArea.y + workArea.height * .72 - height / 2)
  const desiredX = statusOverlayPos
    ? Math.round(clamp(statusOverlayPos.x, workArea.x, workArea.x + workArea.width - width))
    : defaultX
  const desiredY = statusOverlayPos
    ? Math.round(clamp(statusOverlayPos.y, workArea.y, workArea.y + workArea.height - height))
    : defaultY
  return { x: desiredX, y: desiredY, width, height }
}

type StatusOverlayUpdate = { phase: string; level: number; message: string; bounds: Electron.Rectangle }
let lastStatusOverlayMetrics = { updateToShowMs: 0, hotkeyToShowMs: 0, phase: '' }
const statusOverlayController = new WarmOverlay<StatusOverlayUpdate>(async () => {
  const overlay = createOverlayWindow('status', statusOverlayBounds('recording'))
  statusOverlay = overlay
  overlay.setFocusable(false)
  overlay.setIgnoreMouseEvents(false)
  overlay.on('move', () => {
    if (overlay.isDestroyed()) return
    const b = overlay.getBounds()
    statusOverlayPos = { x: b.x, y: b.y }
  })
  overlay.on('closed', () => { if (statusOverlay === overlay) statusOverlay = null })
  try { await overlay.loadURL(overlayHtml(statusOverlayHtml())) }
  catch (error) { if (!overlay.isDestroyed()) overlay.destroy(); throw error }
  return {
    isDestroyed: () => overlay.isDestroyed(),
    apply(value) {
      const previous = overlay.getBounds()
      if (Object.entries(value.bounds).some(([key, item]) => previous[key as keyof Electron.Rectangle] !== item)) {
        overlay.setBounds(value.bounds)
      }
      // Send data directly to the prepared renderer. Do not execute a new script
      // and wait for a round-trip for every audio level tick.
      overlay.webContents.send('statusOverlay:update', { phase: value.phase, level: value.level, message: value.message })
    },
    showInactive: () => { if (!overlay.isVisible()) overlay.showInactive() },
    hide: () => overlay.hide(),
  }
})

async function showStatusOverlay(status: string, level = 0, message = '') {
  if (!isWindows && !isE2EMode) return false
  const startedAt = performance.now()
  const phase = status === 'recording' ? 'recording' : status === 'error' ? 'error' : status === 'result' ? 'result' : 'thinking'
  const previousPhase = lastStatusOverlayMetrics.phase
  const visible = await statusOverlayController.show({ phase, level: Number(level) || 0, message, bounds: statusOverlayBounds(phase) })
  if (visible && previousPhase !== phase) {
    lastStatusOverlayMetrics = { phase, updateToShowMs: performance.now() - startedAt,
      hotkeyToShowMs: lastTriggerAt ? Math.max(0, Date.now() - lastTriggerAt) : 0 }
  }
  return visible
}

function captionOverlayHtml() {
  return `
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; overflow: hidden; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; color: white; }
      .caption { position: relative; width: 100vw; height: 100vh; display: grid; place-items: center; padding: 26px 54px 18px 28px; border-radius: 10px; border: 1px solid rgba(255,255,255,.18); -webkit-app-region: drag; cursor: move; }
      .text { width: 100%; line-height: 1.45; text-align: center; word-break: break-word; white-space: pre-wrap; }
      .actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 5px; }
      button { width: 30px; height: 28px; border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: rgba(15,23,42,.58); color: white; cursor: pointer; -webkit-app-region: no-drag; }
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
  if (!isWindows && !isE2EMode) return false
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

async function startRightAltHook(): Promise<boolean> {
  stopKeyboardHook()
  // Use a WH_KEYBOARD_LL hook (low-level keyboard hook) instead of polling
  // GetAsyncKeyState. This:
  // 1) Detects right Alt press globally while preserving left/right identity
  // 2) BLOCKS the key from reaching the foreground app, preventing cursor
  //    position changes, menu activation, or Alt+key side effects
  if (!isWindows) return true
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$code = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class RightAltHook {
    private const int WH_KEYBOARD_LL = 13;
    private const int VK_RMENU = 0xA5;
    private static IntPtr hookId;
    private static LowLevelKeyboardProc proc = HookCallback;
    private static bool rightAltDown;

    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string lpModuleName);

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            KBDLLHOOKSTRUCT kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if (kb.vkCode == VK_RMENU && (kb.flags & 0x10) == 0) {
                const int WM_KEYDOWN = 0x0100, WM_SYSKEYDOWN = 0x0104, WM_KEYUP = 0x0101, WM_SYSKEYUP = 0x0105;
                if (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN) {
                    if (!rightAltDown) { rightAltDown = true; Console.WriteLine("AltRight"); }
                } else if (wParam == (IntPtr)WM_KEYUP || wParam == (IntPtr)WM_SYSKEYUP) rightAltDown = false;
                // Block the key from reaching the foreground application
                return (IntPtr)1;
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    public static void Run() {
        using (Process curProcess = Process.GetCurrentProcess())
        using (ProcessModule curModule = curProcess.MainModule)
            hookId = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(curModule.ModuleName), 0);
        if (hookId == IntPtr.Zero) throw new InvalidOperationException("Keyboard hook unavailable");
        Console.WriteLine("Ready");
        try { Application.Run(); } finally { UnhookWindowsHookEx(hookId); }
    }
}
"@
Add-Type -TypeDefinition $code -ReferencedAssemblies "System.Windows.Forms"
[RightAltHook]::Run()
`
  const helper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true })
  keyboardHook = helper
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ready: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ready) } }
    const timer = setTimeout(() => { finish(false); helper.kill() }, 8_000)
    // Pipe chunks do not necessarily end at a newline. Read complete events so
    // a split "AltRight" notification cannot silently disappear.
    const lines = createInterface({ input: helper.stdout })
    lines.on('line', (line) => {
      if (keyboardHook !== helper) return
      if (line.trim() === 'Ready') finish(true)
      else if (line.trim() === 'AltRight') emitHotkeyTriggered()
    })
    helper.on('error', () => finish(false))
    helper.on('exit', () => { lines.close(); if (keyboardHook === helper) keyboardHook = null; finish(false) })
  })
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
  if (storageLayout && !storageLayout.snapshot().ready) throw new Error('请先在首页选择可写的数据目录')
  const dir = storageLayout ? storageLayout.snapshot().archiveRoot : path.join(app.getPath('userData'), 'archive')
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

async function archiveTranscription(args: ArchiveArgs) {
  const root = args.archiveRoot || (await defaultArchiveDir())
  const day = localArchiveDay()
  return writeTranscriptionArchive({
    root,
    category: args.archiveCategory || '离线语音识别',
    day,
    taskId: args.taskId,
    filename: args.filename,
    audioBase64: args.audioBase64,
    audioExtension: args.audioExtension,
    metadata: args.metadata,
  })
}

async function saveSummaryLog(args: SummaryLogArgs) {
  const root = args.archiveRoot || (await defaultArchiveDir())
  const day = /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : new Date().toISOString().slice(0, 10)
  const dir = path.join(root, 'summary-logs', day)
  await fs.mkdir(dir, { recursive: true })
  const requested = safeArchiveStem(args.filename || `summary_${day}`)
  const filename = requested.toLowerCase().endsWith('.md') ? requested : `${requested}.md`
  const target = path.join(dir, filename)
  await fs.writeFile(target, args.content, 'utf8')
  return { saved: true, path: target }
}


function stopTextInjectHelper() {
  if (textInjectPending) {
    clearTimeout(textInjectPending.timer)
    textInjectPending.reject(new TextInjectionCancelledError())
    textInjectPending = null
  }
  textInjectHelper?.kill()
  textInjectHelper = null
  settleTextInjectHelperReady?.(false)
  settleTextInjectHelperReady = null
  textInjectHelperReady = null
}

function ensureTextInjectHelper() {
  if (!isWindows) return Promise.resolve(false)
  if (textInjectHelper) return textInjectHelperReady || Promise.resolve(true)
  const encoded = Buffer.from(textInjectHelperScript(), 'utf16le').toString('base64')
  const helper = spawn('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
  textInjectHelper = helper
  textInjectHelperReady = new Promise<boolean>((resolve) => { settleTextInjectHelperReady = resolve })
  const readyPromise = textInjectHelperReady
  let readySeen = false
  let stdoutBuffer = ''
  const readyTimer = setTimeout(() => {
    if (textInjectHelper !== helper || readySeen) return
    console.warn('[text:inject] helper ready handshake timed out')
    textInjectHelper = null
    settleTextInjectHelperReady?.(false)
    settleTextInjectHelperReady = null
    textInjectHelperReady = null
    helper.kill()
  }, TEXT_INJECT_READY_TIMEOUT_MS)

  helper.stdout.on('data', (data: Buffer) => {
    if (textInjectHelper !== helper) return
    stdoutBuffer += data.toString()
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      if (!readySeen && line.includes('"ready"')) {
        readySeen = true
        clearTimeout(readyTimer)
        if (isE2EMode) textInjectDebugEvents.push('helper-ready')
        settleTextInjectHelperReady?.(true)
        settleTextInjectHelperReady = null
        console.log('[text:inject] helper ready')
        continue
      }
      const pending = textInjectPending
      if (!pending || pending.helper !== helper) continue
      try {
        const parsed = JSON.parse(line) as { operation?: string; ok?: boolean; code?: string; retryable?: boolean; hwnd?: string; processId?: number }
        if (parsed.operation !== pending.operation) continue
        clearTimeout(pending.timer)
        textInjectPending = null
        if (pending.operation === 'capture') {
          clearCapturedTextTarget()
          if (parsed.ok && parsed.hwnd && parsed.hwnd !== '0' && parsed.processId) {
            lastTextTargetHwnd = parsed.hwnd
            lastTextTargetProcessId = parsed.processId
            pending.resolve(true)
          } else pending.resolve(false)
        } else if (parsed.ok) {
          clearCapturedTextTarget()
          pending.resolve(true)
        } else {
          const message = textInjectionFailure(parsed.code)
          console.warn(`[text:inject] delivery refused: ${parsed.code || 'unknown'}`)
          pending.reject(parsed.retryable ? new TextInjectionNotSentError(message) : new Error(message))
        }
      } catch {
        clearTimeout(pending.timer)
        textInjectPending = null
        pending.reject(new Error(textInjectionFailure()))
      }
    }
  })
  helper.stderr.on('data', (data: Buffer) => {
    if (textInjectHelper !== helper) return
    const text = data.toString().trimEnd()
    if (!text) return
    if (textInjectPending?.helper === helper) textInjectPending.stderr.push(text)
    console.error('[text:inject] native helper reported an error')
  })
  helper.on('error', (error) => {
    if (textInjectHelper !== helper) return
    clearTimeout(readyTimer)
    textInjectHelper = null
    settleTextInjectHelperReady?.(false)
    settleTextInjectHelperReady = null
    textInjectHelperReady = null
    if (textInjectPending?.helper === helper) {
      clearTimeout(textInjectPending.timer)
      textInjectPending.reject(new Error(textInjectionFailure()))
      textInjectPending = null
    }
  })
  helper.on('exit', () => {
    if (textInjectHelper !== helper) return
    clearTimeout(readyTimer)
    textInjectHelper = null
    settleTextInjectHelperReady?.(false)
    settleTextInjectHelperReady = null
    textInjectHelperReady = null
    if (textInjectPending?.helper === helper) {
      clearTimeout(textInjectPending.timer)
      textInjectPending.reject(new Error(textInjectionFailure()))
      textInjectPending = null
    }
  })
  return readyPromise
}

function clearCapturedTextTarget() {
  lastTextTargetHwnd = '0'
  lastTextTargetProcessId = 0
}

async function sendTextHelperRequest(operation: 'capture' | 'inject', payload: Record<string, unknown> = {}) {
  const ready = await ensureTextInjectHelper()
  if (!ready) throw new TextInjectionNotSentError(textInjectionFailure())
  const helper = textInjectHelper
  if (!helper?.stdin.writable) throw new TextInjectionNotSentError(textInjectionFailure())
  return await new Promise<boolean>((resolve, reject) => {
    if (isE2EMode) textInjectDebugEvents.push(operation === 'capture' ? 'capture-written' : 'request-written')
    const timer = setTimeout(() => {
      const pending = textInjectPending
      if (pending?.helper !== helper || textInjectHelper !== helper) return
      textInjectPending = null
      stopTextInjectHelper()
      // The helper may already have pasted. Never retry an acknowledgement timeout.
      reject(new Error(textInjectionFailure('timeout')))
    }, TEXT_INJECT_TIMEOUT_MS)
    textInjectPending = { operation, helper, resolve, reject, timer, stderr: [] }
    helper.stdin.write(`${JSON.stringify({ operation, ...payload })}\n`, (error) => {
      if (!error) return
      clearTimeout(timer)
      if (textInjectPending?.helper === helper) textInjectPending = null
      // A pipe error after write is ambiguous; it is not retryable.
      reject(new Error(textInjectionFailure()))
    })
  })
}

async function injectTextOnce(text: string) {
  if (!isWindows) return false
  // Each successful capture belongs to one delivery. Never fall back to the
  // current foreground window when capture failed or its original target died.
  if (lastTextTargetHwnd === '0' || !lastTextTargetProcessId) {
    throw new Error(textInjectionFailure('target-missing'))
  }
  return await sendTextHelperRequest('inject', {
    hwnd: lastTextTargetHwnd,
    processId: lastTextTargetProcessId,
    textBase64: Buffer.from(text, 'utf8').toString('base64'),
  })
}

async function captureTextTarget() {
  if (!isWindows) return false
  clearCapturedTextTarget()
  // Capture uses the already prewarmed native helper, not a new PowerShell +
  // Add-Type process with a 600ms cutoff on every recording.
  return await textInjectQueue.run(async () => {
    try { return await sendTextHelperRequest('capture') }
    catch { clearCapturedTextTarget(); return false }
  })
}

async function injectText(text: string) {
  if (!isWindows) return false
  if (!text || !text.trim()) {
    console.warn('[text:inject] skipping empty text injection')
    return false
  }
  // Clipboard.SetText runs in the persistent STA helper. Keeping it off the
  // Electron main thread prevents a foreign clipboard lock from freezing IPC.
  return await textInjectQueue.run(() => runTextInjectionWithRecovery(
    () => injectTextOnce(text),
    stopTextInjectHelper,
  ))
}

async function storageStatus(): Promise<StorageState> {
  if (!storageLayout) throw new Error('受管存储目前支持 Windows 桌面版')
  const state = storageLayout.snapshot()
  const runtime = await localRuntime?.status()
  const busy = storageBusy || !!runtime?.owned || !!runtime && ['installing', 'starting', 'running', 'stopping'].includes(runtime.phase)
  return { ...state, busy, canChange: !busy && state.canChange, canClear: !busy && state.canClear,
    legacyPaths: state.legacyPaths.map(item => ({ ...item, canClear: !busy && item.canClear })) }
}

async function requireStorageIdle(): Promise<void> {
  const runtime = await localRuntime?.status()
  if (runtime?.owned || runtime && ['installing', 'starting', 'running', 'stopping'].includes(runtime.phase)) throw new Error('请先停止本机服务和安装任务，再更改或清理数据目录')
}

function unavailableRuntimeState(): LocalRuntimeState {
  const state = storageLayout?.snapshot()
  const root = state?.runtimeRoot || path.join(app.getPath('userData'), 'local-runtime')
  return { phase: 'missing', installed: false, owned: false, autoStart: false, url: null, root,
    logPath: path.join(root, 'logs', 'backend.log'), message: '请先选择可写的数据目录，再安装本机环境。', error: state?.error }
}

async function configureStorageManagers(state: StorageState): Promise<void> {
  // Caller has checked the previous manager is idle. Never move its venv.
  if (localRuntime) await localRuntime.dispose()
  localRuntime = null
  setPetEnabled(false)
  localAvatar = state.ready ? new LocalAvatarStore(state.avatarRoot, (status) => {
    for (const window of [mainWindow, petWindow]) if (window && !window.isDestroyed()) window.webContents.send('avatar:changed', status)
  }) : null
  if (state.ready) {
    const projectRoot = path.resolve(__dirname, '../../..')
    localRuntime = new LocalRuntimeManager({
      root: state.runtimeRoot, storagePaths: storageLayout!.paths(),
      bundlePath: app.isPackaged ? path.join(process.resourcesPath, 'backend-bundle') : projectRoot,
      uvPath: app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'uv.exe') : path.join(projectRoot, '.runtime/windows-bootstrap/uv.exe'),
      onChange: (value) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:state', value) },
    })
    mainWindow?.webContents.send('runtime:state', await localRuntime.status())
  } else {
    mainWindow?.webContents.send('runtime:state', unavailableRuntimeState())
  }
  mainWindow?.webContents.send('avatar:changed', await localAvatar?.status() || { available: false, name: null, size: 0, revision: null })
}

async function confirmStorageCleanup(root: string): Promise<boolean> {
  const first = await dialog.showMessageBox({ type: 'warning', title: '清理受管数据',
    message: '是否清理这个目录中的环境、模型、缓存和数据？',
    detail: `${root}\n\n其中的模型需要重新下载，本目录的配置、录音、转写、归档及角色副本会永久删除。其它目录和外部共享缓存不受影响。`,
    checkboxLabel: '我已备份需要保留的数据，同意清理所列目录', checkboxChecked: false,
    buttons: ['保留数据', '继续确认清理'], defaultId: 0, cancelId: 0, noLink: true })
  if (first.response !== 1 || !first.checkboxChecked) return false
  const second = await dialog.showMessageBox({ type: 'warning', title: '最后确认',
    message: '确认永久删除所列目录中的受管数据？', detail: root,
    buttons: ['取消', '永久删除'], defaultId: 0, cancelId: 0, noLink: true })
  return second.response === 1
}

function registerIpc() {
  registerPetIpc()
  const avatarSender = (event: Electron.IpcMainInvokeEvent, mainOnly = false) => {
    const window = event.sender === mainWindow?.webContents ? mainWindow : !mainOnly && event.sender === petWindow?.webContents ? petWindow : null
    if (!window || event.senderFrame !== window.webContents.mainFrame || !localAvatar) throw new Error('Only Amadeus windows can access the imported model')
    if (mainOnly && storageBusy) throw new Error('数据目录正在变更，请稍候')
  }
  ipcMain.handle('avatar:status', (event) => { avatarSender(event); return localAvatar!.status() })
  ipcMain.handle('avatar:read', (event) => { avatarSender(event); return localAvatar!.read() })
  ipcMain.handle('avatar:clear', (event) => { avatarSender(event, true); return localAvatar!.clear() })
  ipcMain.handle('avatar:import', async (event) => {
    avatarSender(event, true)
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '导入你自己的 GLB 模型', buttonLabel: '导入模型',
      filters: [{ name: 'GLB 3D 模型', extensions: ['glb'] }], properties: ['openFile'],
    })
    if (selection.canceled || !selection.filePaths[0]) return { ...await localAvatar!.status(), cancelled: true }
    try { return await localAvatar!.importFile(selection.filePaths[0]) } catch (error) {
      return { ...await localAvatar!.status(), error: error instanceof Error ? error.message : '模型导入失败，请检查文件。' }
    }
  })
  const storageAction = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !storageLayout) throw new Error('Only the main Amadeus window can manage data storage')
      return action(...args)
    })
  }
  storageAction('storage:status', storageStatus)
  storageAction('storage:openFolder', async (target) => {
    if (target !== undefined && typeof target !== 'string') throw new Error('Invalid storage path')
    const error = await shell.openPath(storageLayout!.allowedPath(target as string | undefined))
    if (error) throw new Error(error)
  })
  storageAction('storage:chooseDirectory', async () => {
    if (storageBusy) throw new Error('数据目录正在变更，请稍候')
    await requireStorageIdle()
    storageBusy = true
    try {
      const selection = await dialog.showOpenDialog(mainWindow!, { title: '选择数据存储磁盘或父目录（将在其中创建 AmadeusData）',
        buttonLabel: '使用此位置', properties: ['openDirectory', 'createDirectory'] })
      if (selection.canceled || !selection.filePaths[0]) return { ...storageLayout!.snapshot(), cancelled: true }
      await requireStorageIdle()
      const state = await storageLayout!.selectParent(selection.filePaths[0])
      await configureStorageManagers(state)
      return state
    } finally { storageBusy = false }
  })
  storageAction('storage:clearManagedData', async (target) => {
    if (target !== undefined && typeof target !== 'string') throw new Error('Invalid storage path')
    if (storageBusy) throw new Error('数据目录正在变更，请稍候')
    await requireStorageIdle()
    storageBusy = true
    try {
      const root = storageLayout!.allowedPath(target as string | undefined)
      if (!await confirmStorageCleanup(root)) return { ...storageLayout!.snapshot(), cancelled: true }
      await requireStorageIdle()
      const current = root === storageLayout!.snapshot().root
      if (current) { await localRuntime?.dispose(); localRuntime = null; setPetEnabled(false) }
      const state = await storageLayout!.clear(root)
      if (current) await configureStorageManagers(state)
      return state
    } finally { storageBusy = false }
  })
  const runtimeAction = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('Only the main Amadeus window can manage the local environment')
      }
      if (!localRuntime && isWindows && channel === 'runtime:status') return unavailableRuntimeState()
      if (!localRuntime) throw new Error(isWindows ? '请先在首页选择可写的数据目录' : '本机一键安装目前支持 Windows 桌面版')
      if (storageBusy && !['runtime:status', 'runtime:stop'].includes(channel)) throw new Error('数据目录正在变更，请稍候')
      return action(...args)
    })
  }
  runtimeAction('runtime:status', () => localRuntime!.status())
  runtimeAction('runtime:install', () => localRuntime!.install())
  runtimeAction('runtime:installExtra', (extra) => {
    if (typeof extra !== 'string') throw new Error('Invalid runtime component')
    return localRuntime!.installExtra(extra)
  })
  runtimeAction('runtime:start', () => localRuntime!.start())
  runtimeAction('runtime:stop', () => localRuntime!.stop())
  runtimeAction('runtime:autoStart', (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid auto-start preference')
    return localRuntime!.setAutoStart(enabled)
  })
  runtimeAction('runtime:openLogs', async () => {
    const state = await localRuntime!.status()
    await fs.mkdir(path.dirname(state.logPath), { recursive: true })
    await fs.appendFile(state.logPath, '')
    const error = await shell.openPath(state.logPath)
    if (error) throw new Error(error)
  })
  runtimeAction('runtime:openFolder', async () => {
    const state = await localRuntime!.status()
    await fs.mkdir(state.root, { recursive: true })
    const error = await shell.openPath(state.root)
    if (error) throw new Error(error)
  })
  ipcMain.on('win:minimize', () => mainWindow?.minimize())
  ipcMain.on('win:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('win:close', () => mainWindow?.close())
  ipcMain.on('win:closeWithAction', (_event, action: 'hide' | 'quit') => {
    if (action === 'hide') {
      mainWindow?.hide()
      return
    }
    forceQuit = true
    app.quit()
  })
  ipcMain.on('app:keepRunningInBackground:set', (_event, enabled: boolean) => {
    keepRunningInBackground = enabled === true
  })

  ipcMain.handle('dialog:openAudio', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio / Video', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'webm', 'mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v'] }]
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
  ipcMain.handle('text:captureTarget', () => captureTextTarget())
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
  ipcMain.handle('media:extractAudioForUpload', (_event, filePath: string) => {
    if (storageBusy) throw new Error('数据目录正在变更，请稍候')
    if (storageLayout && !storageLayout.snapshot().ready) throw new Error('请先选择可写的数据目录')
    return extractAudioForUpload(filePath, storageLayout?.snapshot().tempRoot)
  })
  ipcMain.handle('archive:transcription', (_event, args: ArchiveArgs) => archiveTranscription(args))
  ipcMain.handle('archive:summaryLog', (_event, args: SummaryLogArgs) => saveSummaryLog(args))
  ipcMain.handle('archive:summaryLogs:list', async (_event, args: { archiveRoot?: string; date: string }) => {
    const root = args.archiveRoot || (await defaultArchiveDir())
    return listSummaryLogs(root, args.date)
  })
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
  ipcMain.handle('text:inject', (_event, text: string) => injectText(text))
  ipcMain.handle('statusOverlay:show', (_event, status: string, level?: number, message?: string) => showStatusOverlay(status, level, message))
  ipcMain.handle('statusOverlay:hide', () => {
    statusOverlayController.hide()
    return true
  })
  ipcMain.on('statusOverlay:copyResultDone', (_event, text: string) => {
    statusOverlayController.hide()
    mainWindow?.webContents.send('statusOverlay:resultCopied', text)
  })
  ipcMain.on('statusOverlay:closeResult', () => {
    statusOverlayController.hide()
    mainWindow?.webContents.send('statusOverlay:resultClosed')
  })
  ipcMain.on('statusOverlay:cancelRecognition', () => {
    statusCancelRequestCount += 1
    mainWindow?.webContents.send('statusOverlay:cancelRecognition')
  })
  ipcMain.on('statusOverlay:submitRecognition', () => {
    statusSubmitRequestCount += 1
    mainWindow?.webContents.send('statusOverlay:submitRecognition')
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

function createStorageLayout(): StorageLayout {
  const projectRoot = path.resolve(__dirname, '../../..')
  return new StorageLayout({ userData: app.getPath('userData'), installDir: path.dirname(app.getPath('exe')),
    // Development and isolated test profiles must never adopt the installed app's data.
    defaultRoot: (isDev || isE2EMode || previewUserData) ? path.join(projectRoot, '.runtime', `desktop-data-${path.basename(app.getPath('userData'))}`) : undefined })
}

async function runUninstallDataCleanup(): Promise<void> {
  // Only entered by an explicit interactive uninstall. No backend, window, tray,
  // native hooks or auto-start are registered in this mode.
  const layout = createStorageLayout()
  const state = await layout.initialize({ create: false })
  const targets = [ ...(state.canClear ? [state.root] : []), ...state.legacyPaths.filter(item => item.canClear).map(item => item.path) ]
  const protectedPaths = state.legacyPaths.filter(item => !item.canClear).map(item => item.path)
  if (!state.ready && state.error) protectedPaths.push(state.root)
  let failed = false
  for (const root of targets) {
    if (!await confirmStorageCleanup(root)) continue
    const result = await layout.clear(root)
    if (result.cleanup?.status === 'failed') {
      failed = true
      await dialog.showMessageBox({ type: 'error', title: '数据清理未完成', message: '程序可以继续卸载；请检查以下目录中剩余的数据。',
        detail: `${root}\n\n${result.cleanup.message}`, buttons: ['保留数据并继续'], defaultId: 0 })
    }
  }
  if (protectedPaths.length) await dialog.showMessageBox({ type: 'info', title: '已保留原有数据',
    message: '以下目录没有可验证的受管删除权限，已保留。', detail: protectedPaths.join('\n'), buttons: ['继续卸载'], defaultId: 0 })
  app.exit(failed ? 2 : 0)
}

async function startApplication() {
  if (isE2EMode) app.setAccessibilitySupportEnabled(true)
  if (isWindows) {
    storageLayout = createStorageLayout()
    await configureStorageManagers(await storageLayout.initialize())
    void localRuntime?.status().then((state) => {
      if (state.autoStart && state.installed) return localRuntime!.start()
    }).catch((error) => console.error('Local runtime startup failed:', error instanceof Error ? error.message : 'Unknown error'))
  } else {
    localAvatar = new LocalAvatarStore(path.join(app.getPath('userData'), 'avatars'), (status) => {
      for (const window of [mainWindow, petWindow]) if (window && !window.isDestroyed()) window.webContents.send('avatar:changed', status)
    })
  }
  configureDisplayMediaCapture()
  registerIpc()
  if (isWindows) void ensureTextInjectHelper()
  createWindow()
  if (isWindows || isE2EMode) void statusOverlayController.prepare().catch(() => console.warn('Status overlay warm-up failed'))
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
          captureTextTarget,
          injectText,
          waitTextInjectReady: () => ensureTextInjectHelper(),
          getTextInjectDebugEvents: () => [...textInjectDebugEvents],
          writeUserId,
          readUserId,
          getCaptionRequestCounts: () => ({
            close: captionCloseRequestCount,
            settings: captionSettingsRequestCount
          }),
          getStatusRecognitionRequestCounts: () => ({
            cancel: statusCancelRequestCount,
            submit: statusSubmitRequestCount
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
}

if (gotInstanceLock) {
  app.on('second-instance', showMainWindow)
  void app.whenReady().then(isUninstallDataMode ? runUninstallDataCleanup : startApplication).catch((error) => {
    dialog.showErrorBox('Amadeus 启动失败', error instanceof Error ? error.message : '未知错误')
    app.exit(2)
  })
} else {
  // Never register startup for a duplicate: no window, tray, hooks or backend.
  if (isUninstallDataMode) app.exit(3)
  else app.quit()
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  petWindow?.destroy()
  globalShortcut.unregisterAll()
  stopMouseHook()
  stopKeyboardHook()
  stopTextInjectHelper()
  tray?.destroy()
})

// Keep the Electron event loop alive until the owned installer/backend has exited.
app.on('before-quit', (event) => {
  if (!localRuntime || runtimeQuitFinished) return
  event.preventDefault()
  if (runtimeQuitPending) return
  runtimeQuitPending = true
  forceQuit = true
  void localRuntime.dispose().finally(() => {
    runtimeQuitFinished = true
    app.quit()
  })
})
