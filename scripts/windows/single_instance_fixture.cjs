// Disposable Electron process for verify_single_instance.cjs. Never targets a
// running Amadeus app: each invocation receives a private appData namespace.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  if (!value) throw new Error(`Missing fixture argument ${name}`);
  return value.slice(prefix.length);
}

const root = path.resolve(argument('fixture-root'));
const id = argument('fixture-id');
if (!/^instance-[a-z0-9-]+$/.test(id)) throw new Error('Invalid fixture id');
const profile = path.join(root, 'profiles', id);
const appData = path.join(root, 'appData');
const logFile = path.join(root, `${id}.jsonl`);
const commandFile = path.join(root, `${id}.command.json`);
const windowDelay = Number(argument('window-delay'));
const { acquireAppInstanceLock } = require(path.resolve(argument('lock-helper')));
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(appData, { recursive: true });

function emit(event, data = {}) {
  fs.appendFileSync(logFile, JSON.stringify({ event, pid: process.pid, at: Date.now(), ...data }) + '\n');
}

app.setName('Amadeus');
app.setPath('appData', appData);
app.setPath('userData', profile);
const acquired = acquireAppInstanceLock(app);
emit('lock', { acquired, userData: app.getPath('userData'), profile, appData, electronVersion: process.versions.electron });

if (!acquired) {
  // Electron may still emit ready after quit is requested. This observer records
  // that fact without registering the application startup path below.
  app.on('ready', () => emit('native-ready-after-rejection'));
  app.quit();
} else {
  let window = null;
  let pendingActivation = false;
  let cleanupDelay = 0;
  let cleanupStarted = false;
  let cleanupFinished = false;
  let commandTimer = null;

  const state = () => ({
    visible: Boolean(window && !window.isDestroyed() && window.isVisible()),
    minimized: Boolean(window && !window.isDestroyed() && window.isMinimized()),
    focused: Boolean(window && !window.isDestroyed() && window.isFocused()),
    hasLock: app.hasSingleInstanceLock(),
  });
  const activate = () => {
    if (!window || window.isDestroyed()) {
      pendingActivation = true;
      return;
    }
    window.restore();
    window.show();
    window.focus();
    setTimeout(() => emit('activated', state()), 120);
  };

  app.on('second-instance', () => {
    emit('second-instance', { queued: !window, ...state() });
    activate();
  });
  app.on('before-quit', (event) => {
    if (!cleanupDelay || cleanupFinished) return;
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    emit('cleanup-started', state());
    setTimeout(() => {
      cleanupFinished = true;
      emit('cleanup-finished', state());
      app.quit();
    }, cleanupDelay);
  });
  app.on('quit', () => {
    if (commandTimer) clearInterval(commandTimer);
    emit('quit');
  });

  app.whenReady().then(() => {
    emit('ready');
    setTimeout(() => {
      window = new BrowserWindow({ width: 420, height: 180, show: false, skipTaskbar: true,
        title: 'Amadeus single-instance verification',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      window.once('ready-to-show', () => {
        emit('window-ready', state());
        if (pendingActivation) {
          pendingActivation = false;
          activate();
        }
      });
      window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<title>Amadeus single-instance verification</title><p>Disposable single-instance test. This window closes automatically.</p>'
      ));
    }, windowDelay);
    commandTimer = setInterval(() => {
      if (!fs.existsSync(commandFile)) return;
      const command = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
      fs.unlinkSync(commandFile);
      if (command.action === 'quit') {
        cleanupDelay = command.delay || 0;
        app.quit();
        return;
      }
      if (!window || window.isDestroyed()) throw new Error('Fixture window is not ready');
      if (command.action === 'hide') window.hide();
      else if (command.action === 'minimize') { window.show(); window.minimize(); }
      else if (command.action !== 'snapshot') throw new Error('Unknown fixture command');
      setTimeout(() => emit('command', { command: command.id, action: command.action, ...state() }), 120);
    }, 40);
  });
}
