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
import { LatestTaskQueue } from './latest-task-queue'
import { calculateInitialWindowBounds } from './window-layout'

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
if (isE2EMode) app.commandLine.appendSwitch('force-renderer-accessibility')
const e2eUserData = process.argv.find((arg) => arg.startsWith('--amadeus-e2e-user-data='))?.slice('--amadeus-e2e-user-data='.length)

let mainWindow: BrowserWindow | null = null
let statusOverlay: BrowserWindow | null = null
let captionOverlay: BrowserWindow | null = null
// User-dragged position of the status overlay, kept across phase transitions
// within a session so recording→thinking→result don't snap back to center.
let statusOverlayPos: { x: number; y: number } | null = null
let tray: Tray | null = null
let forceQuit = false
let mouseHook: ChildProcessWithoutNullStreams | null = null
let keyboardHook: ChildProcessWithoutNullStreams | null = null
let textInjectHelper: ChildProcessWithoutNullStreams | null = null
let textInjectHelperReady: Promise<boolean> | null = null
let settleTextInjectHelperReady: ((ready: boolean) => void) | null = null
let textInjectPending: {
  helper: ChildProcessWithoutNullStreams
  resolve: (value: boolean) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  stderr: string[]
} | null = null
const textInjectQueue = new LatestTaskQueue<boolean>(() => stopTextInjectHelper())
let lastTextTargetHwnd = '0'
let lastTextTargetProcess = ''
let lastTextTargetCapturedAt = 0
let registeredHotkey = ''
let lastTriggerAt = 0
let captionCloseRequestCount = 0
let captionSettingsRequestCount = 0
let statusCancelRequestCount = 0
let statusSubmitRequestCount = 0
const TEXT_INJECT_TIMEOUT_MS = 475
const textInjectDebugEvents: string[] = []

app.setName('Amadeus')
if (isWindows) app.setAppUserModelId('com.asrapp.desktop')
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
  const initialBounds = calculateInitialWindowBounds(screen.getPrimaryDisplay().workArea)

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
    // Always prevent default synchronously — Electron requires this
    // before the first await, otherwise the window may be destroyed.
    // We decide below whether to actually close, hide, or ask.
    if (!isWindows || forceQuit) return

    event.preventDefault()

    const preference = await readClosePreference()

    if (preference === 'quit') {
      forceQuit = true
      mainWindow?.close()
      return
    }

    if (preference === 'background') {
      mainWindow?.hide()
      return
    }

    // preference === 'ask' (default)
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
      mainWindow?.close()
    }
    // response === 2 (取消): nothing — close was already prevented
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
  // restore() must come before show() — when the window was hidden to tray
  // it is not "minimized", so isMinimized() would return false.  restore()
  // handles both minimized and hidden-then-needs-restore edge cases.
  mainWindow.restore()
  mainWindow.show()
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
          sandbox: false
        }
      : {
          preload: path.join(__dirname, 'status-overlay-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false
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
      })();
    </script>`
}

async function showStatusOverlay(status: string, level = 0, message = '') {
  if (!isWindows && !isE2EMode) return false
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
  if (!statusOverlay || statusOverlay.isDestroyed()) {
    statusOverlay = createOverlayWindow('status', {
      x: desiredX,
      y: desiredY,
      width,
      height
    })
    await statusOverlay.loadURL(overlayHtml(statusOverlayHtml()))
    // Remember the position when the user drags the frameless window.
    statusOverlay.on('move', () => {
      if (!statusOverlay || statusOverlay.isDestroyed()) return
      const b = statusOverlay.getBounds()
      statusOverlayPos = { x: b.x, y: b.y }
    })
  } else {
    // Resize if needed when switching between phases, keeping position.
    statusOverlay.setBounds({
      x: desiredX,
      y: desiredY,
      width,
      height
    })
  }
  const phase = status === 'recording' ? 'recording' : status === 'error' ? 'error' : status === 'result' ? 'result' : 'thinking'
  statusOverlay.setFocusable(false)
  // Controls receive clicks; the top strip moves the frameless overlay.
  statusOverlay.setIgnoreMouseEvents(false)
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

function startRightAltHook() {
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
            if (kb.vkCode == VK_RMENU) {
                // Detect key down (not auto-repeat)
                const int WM_KEYDOWN = 0x0100, WM_SYSKEYDOWN = 0x0104;
                if ((wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN) && (kb.flags & 0x80) == 0) {
                    Console.WriteLine("AltRight");
                }
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
        Application.Run();
    }
}
"@
Add-Type -TypeDefinition $code -ReferencedAssemblies "System.Windows.Forms"
[RightAltHook]::Run()
`
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

function textInjectHelperScript() {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$pasteCode = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class AmadeusPaste {
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);

  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUT_UNION u; }

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;

  static void Key(ushort vk, bool up) {
    var input = new INPUT { type = INPUT_KEYBOARD };
    input.u.ki.wVk = vk;
    input.u.ki.wScan = 0;
    input.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void SendCtrlV() {
    Key(0x12, true);  // Alt up: right-Alt hotkey can leave Alt logically down in some apps.
    Key(0x11, true);  // Ctrl up
    Key(0x10, true);  // Shift up
    Thread.Sleep(6);
    Key(0x11, false); Thread.Sleep(6);
    Key(0x56, false); Thread.Sleep(6);
    Key(0x56, true);  Thread.Sleep(4);
    Key(0x11, true);
  }

  public static bool RestoreTarget(string hwndText) {
    long hwndValue;
    if (!long.TryParse(hwndText, out hwndValue)) return false;
    var hwnd = new IntPtr(hwndValue);
    if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
    return SetForegroundWindow(hwnd);
  }
}
'@
Add-Type -TypeDefinition $pasteCode -ReferencedAssemblies "System.Windows.Forms"

function Write-Result($ok, $editable, $message) {
  [Console]::Out.WriteLine((@{ ok = $ok; editable = $editable; message = $message } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Test-FocusedEditable {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $focused -or -not $focused.Current.IsEnabled) {
    return @{ ok = $false; message = 'no-focus: focused is null or disabled' }
  }
  $processName = ''
  try {
    $processName = (Get-Process -Id $focused.Current.ProcessId -ErrorAction Stop).ProcessName
  } catch {}
  $compatTarget = $processName -match '^(QQ|TIM|WeChat|Weixin|WXWork)$'

  $valuePattern = $null
  if ($focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    if ($valuePattern.Current.IsReadOnly) {
      return @{ ok = $false; message = ('readonly-value: name={0} class={1}' -f $focused.Current.Name, $focused.Current.ClassName) }
    }
  }

  $ctrlType = $focused.Current.ControlType
  $nonTextTypes = @(
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::CheckBox,
    [System.Windows.Automation.ControlType]::RadioButton,
    [System.Windows.Automation.ControlType]::SplitButton,
    [System.Windows.Automation.ControlType]::List,
    [System.Windows.Automation.ControlType]::ListItem,
    [System.Windows.Automation.ControlType]::Menu,
    [System.Windows.Automation.ControlType]::MenuBar,
    [System.Windows.Automation.ControlType]::MenuItem,
    [System.Windows.Automation.ControlType]::Tab,
    [System.Windows.Automation.ControlType]::TabItem,
    [System.Windows.Automation.ControlType]::Tree,
    [System.Windows.Automation.ControlType]::TreeItem,
    [System.Windows.Automation.ControlType]::ScrollBar,
    [System.Windows.Automation.ControlType]::Thumb,
    [System.Windows.Automation.ControlType]::ProgressBar,
    [System.Windows.Automation.ControlType]::Slider,
    [System.Windows.Automation.ControlType]::Spinner,
    [System.Windows.Automation.ControlType]::Separator,
    [System.Windows.Automation.ControlType]::Hyperlink,
    [System.Windows.Automation.ControlType]::Calendar
  )
  if ($ctrlType -in $nonTextTypes) {
    if ($compatTarget) {
      return @{ ok = $true; compat = $true; process = $processName; message = ('compat-target: process={0} ctrlType={1} name={2} class={3}' -f $processName, $ctrlType.ProgrammaticName, $focused.Current.Name, $focused.Current.ClassName) }
    }
    return @{ ok = $false; message = ('non-text-ctrl: ctrlType={0} name={1} class={2}' -f $ctrlType.ProgrammaticName, $focused.Current.Name, $focused.Current.ClassName) }
  }

  return @{ ok = $true; compat = $compatTarget; process = $processName; message = ('inject-target: process={0} ctrlType={1} name={2} class={3} autoId={4}' -f $processName, $ctrlType.ProgrammaticName, $focused.Current.Name, $focused.Current.ClassName, $focused.Current.AutomationId) }
}

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $targetHwnd = '0'
    $targetProcess = ''
    $textB64 = $line.Trim()
    if ($textB64.Contains("\`t")) {
      $parts = $textB64.Split("\`t")
      $targetHwnd = $parts[0].Trim()
      if ($parts.Length -ge 3) {
        $targetProcess = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($parts[1].Trim()))
        $textB64 = $parts[2].Trim()
      } else {
        $textB64 = $parts[1].Trim()
      }
    }
    $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($textB64))
    [System.Windows.Forms.Clipboard]::SetText($text)
    if (-not [string]::IsNullOrWhiteSpace($targetHwnd) -and $targetHwnd -ne '0') {
      [void][AmadeusPaste]::RestoreTarget($targetHwnd)
      Start-Sleep -Milliseconds 35
      if ($targetProcess -eq 'AmadeusE2E') {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int64]$targetHwnd))
        $editCondition = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Edit
        )
        $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
        if ($null -ne $edit) {
          $edit.SetFocus()
          Start-Sleep -Milliseconds 20
        }
      }
    }
    if ($targetProcess -match '^(QQ|TIM|WeChat|Weixin|WXWork)$') {
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Write-Result $true $true ('compat-captured-target: process={0}' -f $targetProcess)
      continue
    }
    $editable = Test-FocusedEditable
    if (-not $editable.ok) {
      Write-Result $false $false $editable.message
      continue
    }
    if ($editable.compat) {
      [System.Windows.Forms.SendKeys]::SendWait('^v')
    } else {
      [AmadeusPaste]::SendCtrlV()
    }
    Write-Result $true $true $editable.message
  } catch {
    Write-Result $false $true ("inject-error: " + $_.Exception.Message)
  }
}
`
}

function stopTextInjectHelper() {
  if (textInjectPending) {
    clearTimeout(textInjectPending.timer)
    textInjectPending.reject(new Error('文本注入 helper 已停止'))
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
  let readySeen = false

  helper.stdout.on('data', (data: Buffer) => {
    if (textInjectHelper !== helper) return
    for (const rawLine of data.toString().split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      if (!readySeen && line.includes('"ready"')) {
        readySeen = true
        if (isE2EMode) textInjectDebugEvents.push('helper-ready')
        settleTextInjectHelperReady?.(true)
        settleTextInjectHelperReady = null
        console.log('[text:inject] helper ready')
        continue
      }
      const pending = textInjectPending
      if (!pending || pending.helper !== helper) continue
      clearTimeout(pending.timer)
      textInjectPending = null
      try {
        const parsed = JSON.parse(line) as { ok?: boolean; editable?: boolean; message?: string }
        if (parsed.ok) {
          if (parsed.message) console.log(`[text:inject] ${parsed.message}`)
          pending.resolve(true)
        } else if (parsed.editable === false) {
          console.warn(`[text:inject] focus not editable. ${parsed.message || ''}`)
          pending.resolve(false)
        } else {
          pending.reject(new Error(parsed.message || '文本注入失败，文本已保留在剪贴板'))
        }
      } catch {
        pending.reject(new Error(`文本注入 helper 返回异常: ${line}`))
      }
    }
  })
  helper.stderr.on('data', (data: Buffer) => {
    if (textInjectHelper !== helper) return
    const text = data.toString().trimEnd()
    if (!text) return
    if (textInjectPending?.helper === helper) textInjectPending.stderr.push(text)
    console.error(`[text:inject helper stderr] ${text}`)
  })
  helper.on('error', (error) => {
    if (textInjectHelper !== helper) return
    textInjectHelper = null
    settleTextInjectHelperReady?.(false)
    settleTextInjectHelperReady = null
    textInjectHelperReady = null
    if (textInjectPending?.helper === helper) {
      clearTimeout(textInjectPending.timer)
      textInjectPending.reject(error)
      textInjectPending = null
    }
  })
  helper.on('exit', () => {
    if (textInjectHelper !== helper) return
    textInjectHelper = null
    settleTextInjectHelperReady?.(false)
    settleTextInjectHelperReady = null
    textInjectHelperReady = null
    if (textInjectPending?.helper === helper) {
      clearTimeout(textInjectPending.timer)
      const detail = textInjectPending.stderr.join('\n').trim()
      textInjectPending.reject(new Error(detail || '文本注入 helper 已退出'))
      textInjectPending = null
    }
  })
  return textInjectHelperReady!
}

async function injectTextOnce(text: string) {
  if (!isWindows) return false
  const ready = await ensureTextInjectHelper()
  if (!ready) throw new Error('文本注入 helper 启动失败')
  const helper = textInjectHelper
  if (!helper?.stdin.writable) throw new Error('文本注入 helper 未就绪')
  const textB64 = Buffer.from(text, 'utf8').toString('base64')
  const targetHwnd = Date.now() - lastTextTargetCapturedAt < 120_000 ? lastTextTargetHwnd : '0'
  const capturedProcess = Date.now() - lastTextTargetCapturedAt < 120_000 ? lastTextTargetProcess : ''
  const targetProcessB64 = Buffer.from(isE2EMode && capturedProcess === 'Amadeus' ? 'AmadeusE2E' : capturedProcess, 'utf8').toString('base64')
  return await new Promise<boolean>((resolve, reject) => {
    if (isE2EMode) textInjectDebugEvents.push('request-written')
    const timer = setTimeout(() => {
      const pending = textInjectPending
      if (pending?.helper !== helper || textInjectHelper !== helper) return
      textInjectPending = null
      stopTextInjectHelper()
      reject(new Error(`文本注入超时，文本已保留在剪贴板${pending?.stderr.length ? `：${pending.stderr.join('\n')}` : ''}`))
    }, TEXT_INJECT_TIMEOUT_MS)
    textInjectPending = { helper, resolve, reject, timer, stderr: [] }
    helper.stdin.write(`${targetHwnd}\t${targetProcessB64}\t${textB64}\n`, (error) => {
      if (!error) return
      clearTimeout(timer)
      if (textInjectPending?.helper === helper) textInjectPending = null
      reject(error)
    })
  })
}

async function captureTextTarget() {
  if (!isWindows) return false
  const script = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
public static class AmadeusForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
Add-Type -TypeDefinition $code
$hwnd = [AmadeusForeground]::GetForegroundWindow()
$targetPid = [uint32]0
[void][AmadeusForeground]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
$processName = ''
try { $processName = (Get-Process -Id $targetPid -ErrorAction Stop).ProcessName } catch {}
@{ ok = ($hwnd -ne [IntPtr]::Zero); hwnd = $hwnd.ToInt64(); process = $processName } | ConvertTo-Json -Compress
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return await new Promise<boolean>((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
    let stdout = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, 600)
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.on('error', () => finish(false))
    child.on('exit', () => {
      try {
        const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; hwnd?: number | string; process?: string }
        const hwnd = String(parsed.hwnd || '0')
        if (parsed.ok && hwnd !== '0') {
          lastTextTargetHwnd = hwnd
          lastTextTargetProcess = parsed.process || ''
          lastTextTargetCapturedAt = Date.now()
          console.log(`[text:inject] captured target hwnd=${hwnd} process=${parsed.process || ''}`)
          finish(true)
          return
        }
      } catch {
        // ignore malformed capture output
      }
      finish(false)
    })
  })
}

async function injectText(text: string) {
  if (!isWindows) return false
  if (!text || !text.trim()) {
    console.warn('[text:inject] skipping empty text injection')
    return false
  }
  return await textInjectQueue.run(() => injectTextOnce(text))
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
  ipcMain.on('text:toClipboard', (_event, text: string) => {
    clipboard.writeText(text)
  })
  ipcMain.handle('text:inject', (_event, text: string) => injectText(text))
  ipcMain.handle('statusOverlay:show', (_event, status: string, level?: number, message?: string) => showStatusOverlay(status, level, message))
  ipcMain.handle('statusOverlay:hide', () => {
    statusOverlay?.hide()
    return true
  })
  ipcMain.on('statusOverlay:copyResult', (_event, text: string) => {
    clipboard.writeText(text)
    statusOverlay?.hide()
    mainWindow?.webContents.send('statusOverlay:resultCopied', text)
  })
  ipcMain.on('statusOverlay:closeResult', () => {
    statusOverlay?.hide()
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

const gotLock = isE2EMode || app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', showMainWindow)

app.whenReady().then(() => {
  if (isE2EMode) app.setAccessibilitySupportEnabled(true)
  configureDisplayMediaCapture()
  registerIpc()
  if (isWindows) void ensureTextInjectHelper()
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
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopMouseHook()
  stopKeyboardHook()
  stopTextInjectHelper()
  tray?.destroy()
})
