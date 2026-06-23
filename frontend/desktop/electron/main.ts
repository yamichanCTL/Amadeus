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
    width: 1280,
    height: 800,
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
      .box { width: 100vw; height: 100vh; display: grid; grid-template-columns: 122px minmax(0, 1fr); align-items: center; gap: 6px; padding: 4px 7px; background: rgba(14, 22, 35, .9); border: 1px solid rgba(255,255,255,.2); border-radius: 9px; box-shadow: 0 8px 20px rgba(0,0,0,.28); }
      .box.result { grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 7px 9px; border-radius: 12px; }
      .wave { height: 22px; display: flex; align-items: center; justify-content: flex-start; gap: 2px; overflow: hidden; }
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
      .result .wave, .result .copy { display: none; }
      @keyframes think-wave { 0%, 100% { height: 3px; opacity: .5; } 50% { height: 19px; opacity: 1; } }
    </style>
    <div class="box" id="box">
      <div class="wave" id="wave">${Array.from({ length: 28 }, () => '<i></i>').join('')}</div>
      <div class="copy" id="copyBlock"><strong id="title">语音输入中</strong><small id="detail" style="display:none"></small></div>
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
  if (!isWindows) return false
  const workArea = screen.getPrimaryDisplay().workArea
  const width = status === 'result' ? 360 : 200
  const height = status === 'result' ? 64 : 32
  if (!statusOverlay || statusOverlay.isDestroyed()) {
    statusOverlay = createOverlayWindow('status', {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + workArea.height * .72 - height / 2),
      width,
      height
    })
    await statusOverlay.loadURL(overlayHtml(statusOverlayHtml()))
  } else {
    // Resize if needed when switching between phases
    statusOverlay.setBounds({
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + workArea.height * .72 - height / 2),
      width,
      height
    })
  }
  const phase = status === 'recording' ? 'recording' : status === 'error' ? 'error' : status === 'result' ? 'result' : 'thinking'
  const interactive = phase === 'result'
  statusOverlay.setFocusable(interactive)
  statusOverlay.setIgnoreMouseEvents(!interactive)
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

async function injectText(text: string) {
  if (!isWindows) return false

  // Encode the text as base64 so it survives PowerShell string interpolation
  // without injection risk (backticks, quotes, dollar signs are all safe).
  const textB64 = Buffer.from(text, 'utf8').toString('base64')

  // Combined focus detection AND text injection in a single PowerShell process.
  // Running two separate spawns (one to check focus, another to send keys)
  // created a timing gap where focus could shift between them. A single process
  // eliminates that gap.
  //
  // Two injection methods are used in sequence (belt-and-suspenders):
  // 1. WM_PASTE  — sent directly to the target HWND, bypasses keyboard hooks
  //                and IME interception (critical for QQ and similar apps).
  // 2. SendInput — standard Ctrl+V simulation with scan codes, covering
  //                Electron/Chromium apps that ignore WM_PASTE.
  // Both operate on the same clipboard; the app only processes one.
  const combinedScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${textB64}'))

# === Phase 1: Focus detection (same logic as before) ===

try {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $focused -or -not $focused.Current.IsEnabled -or -not $focused.Current.IsKeyboardFocusable) {
    exit 3
  }

  $editable = $false
  $valuePattern = $null

  if ($focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    if (-not $valuePattern.Current.IsReadOnly) {
      $editable = $true
    } else {
      exit 3
    }
  }

  if (-not $editable) {
    if ($focused.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
      $editable = $true
    }
  }

  # Electron/Chromium custom editors and native RichEdit controls commonly
  # expose a focusable Document, Pane, Group or Custom control type without
  # ValuePattern. Instead of a fragile process-name whitelist (which breaks
  # every time the user switches chat apps), use control-type heuristics that
  # work across ALL applications.
  #
  # These control types are the standard building blocks of rich text editors
  # in: Electron apps (QQ, VS Code, Discord, Slack, DingTalk, Feishu, etc.),
  # native Win32 RichEdit, Qt editors, and browser contenteditable surfaces.
  if (-not $editable) {
    $ctrlType = $focused.Current.ControlType
    $isTextHost = ($ctrlType -eq [System.Windows.Automation.ControlType]::Document) -or
                  ($ctrlType -eq [System.Windows.Automation.ControlType]::Pane) -or
                  ($ctrlType -eq [System.Windows.Automation.ControlType]::Group) -or
                  ($ctrlType -eq [System.Windows.Automation.ControlType]::Custom)

    if ($isTextHost) {
      # Additional signal: TextPattern indicates rich text editing capability
      $textPattern = $null
      $hasTextPattern = $focused.TryGetCurrentPattern(
        [System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern
      )

      # Element naming hints (case-insensitive substring match)
      $name = $focused.Current.Name
      $className = $focused.Current.ClassName
      $autoId = $focused.Current.AutomationId
      $looksLikeEditor = $hasTextPattern -or
        $name -match '编辑|输入|内容|text|edit|input|chat|message|content|rich|compose|editor|document|body|draft|reply|comment|note|code' -or
        $className -match 'edit|input|rich|text|chat|content|webview|render|document|scintilla|richtext' -or
        $autoId -match 'edit|input|text|chat|message|content|rich|compose'

      # Control type alone is a strong signal: a keyboard-focused Document/Pane
      # without ValuePattern is almost always a rich text editor. The naming
      # hints and TextPattern just add confidence. We treat it as editable
      # even without those extra signals — a false positive (paste into a
      # non-text Pane) is harmless (Ctrl+V silently ignored), while a false
      # negative breaks the entire auto-inject feature for that app.
      $editable = $true
    }
  }

  if (-not $editable) { exit 3 }

  # === Phase 2: Inject text at cursor ===
  #
  # We do NOT use ValuePattern.SetValue — it replaces ALL content instead of
  # inserting at the cursor position (regression: overwrites existing text in
  # VSCode, browser forms, etc.). Clipboard-based paste inserts at cursor.

  # Walk up the UI Automation tree to find a window with a real HWND.
  # WM_PASTE needs a target window handle; this also bypasses keyboard hooks
  # and IME/TSF interception that can block SendInput in apps like QQ.
  $targetHwnd = [IntPtr]::Zero
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $current = $focused
  while ($current -ne $null -and $targetHwnd -eq [IntPtr]::Zero) {
    $hwnd = $current.Current.NativeWindowHandle
    if ($hwnd -ne 0) { $targetHwnd = [IntPtr]$hwnd }
    try { $current = $walker.GetParent($current) } catch { break }
  }

  # Write text to clipboard (always — both methods need it)
  [System.Windows.Forms.Clipboard]::SetText($text)
  Start-Sleep -Milliseconds 80

  $pasteCode = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class AmadeusPaste {
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);

  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUT_UNION u; }

  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_SCANCODE = 0x0008;
  const uint WM_PASTE = 0x0302;

  // Method 1: WM_PASTE directly to the target window.
  // Bypasses keyboard hooks, IME/TSF interception, and UIPI restrictions.
  // Works for: native Win32 controls, Chromium/Electron render windows.
  public static void TryWmPaste(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return;
    SendMessage(hwnd, WM_PASTE, IntPtr.Zero, IntPtr.Zero);
  }

  // Method 2: SendInput with scan codes.
  // SendInput places keystrokes in the system input queue; they are dispatched
  // to the foreground window's thread. Including scan codes (MapVirtualKey)
  // makes the simulated input indistinguishable from real keyboard input,
  // improving compatibility with apps that validate scan codes.
  static void Key(ushort vk, bool up) {
    var input = new INPUT { type = INPUT_KEYBOARD };
    input.u.ki.wVk = vk;
    input.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    if (up) input.u.ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
    else input.u.ki.dwFlags = KEYEVENTF_SCANCODE;
    SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void SendCtrlV() {
    Thread.Sleep(50);
    Key(0x11, false); Thread.Sleep(50);   // Ctrl down
    Key(0x56, false); Thread.Sleep(50);   // V down
    Key(0x56, true);  Thread.Sleep(30);   // V up
    Key(0x11, true);                       // Ctrl up
  }
}
'@
  Add-Type -TypeDefinition $pasteCode -ReferencedAssemblies "System.Windows.Forms"

  # Two-pronged paste: WM_PASTE for apps that block simulated keyboard input
  # (QQ etc.), SendInput for apps that only process paste via keyboard events.
  # Both operate on the same clipboard content; the app will only accept one.
  if ($targetHwnd -ne [IntPtr]::Zero) {
    [AmadeusPaste]::TryWmPaste($targetHwnd)
    Start-Sleep -Milliseconds 60
  }
  [AmadeusPaste]::SendCtrlV()
  exit 0

} catch {
  Write-Error $_
  exit 4
}
`
  const encoded = Buffer.from(combinedScript, 'utf16le').toString('base64')

  // Single spawn: detect focus AND inject text in one shot.
  // Exit codes: 0 = injected successfully, 3 = not an editable field,
  //             anything else = error.
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
    const timer = setTimeout(() => { child.kill(); reject(new Error('文本注入超时，文本已保留在剪贴板')) }, 4000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(true)
      else if (code === 3) resolve(false)
      else reject(new Error(`文本注入失败 (${code ?? 'unknown'})，文本已保留在剪贴板`))
    })
  })
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
  ipcMain.on('statusOverlay:copyResult', (_event, text: string) => {
    clipboard.writeText(text)
    statusOverlay?.hide()
    mainWindow?.webContents.send('statusOverlay:resultCopied', text)
  })
  ipcMain.on('statusOverlay:closeResult', () => {
    statusOverlay?.hide()
    mainWindow?.webContents.send('statusOverlay:resultClosed')
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
