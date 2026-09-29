// Drives only an explicitly launched Amadeus QA instance; no browser or user microphone.
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('../../frontend/desktop/node_modules/ws');
const output = path.resolve(__dirname, '../../.runtime/windows-setup-qa');
fs.mkdirSync(output, { recursive: true });
const address = 'http://127.0.0.1:9232';
const report = { passed: false, checks: {}, apiCalls: 0, microphone: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, sequence = 0;
const pending = new Map();
async function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function run(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || 'Page evaluation failed');
  return result.result.value;
}
async function until(check, label, timeout = 30000, interval = 200) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await check(); if (value) return value; await delay(interval); }
  throw Error(`Timed out: ${label}`);
}
async function click(label) {
  return run(`(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}); if(!b||b.disabled) throw Error('Missing button: '+${JSON.stringify(label)}); b.click(); return true; })()`);
}
const state = () => run('window.electronAPI.localRuntimeStatus()');
async function waitPhase(phase, timeout = 30000) {
  let last = '';
  return until(async () => {
    const s = await state();
    if (s.phase === 'error') throw Error(s.error || s.message);
    if (last !== s.message) { console.log(s.phase + ': ' + s.message); last = s.message; }
    return s.phase === phase ? s : null;
  }, phase, timeout, 1000);
}
async function screenshot(name) {
  await send('Page.bringToFront');
  await delay(400);
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
}
(async () => {
  try {
    const target = await until(async () => {
      try { return (await (await fetch(address + '/json/list')).json()).find(t => t.type === 'page' && t.url.includes('index.html')); } catch { return null; }
    }, 'QA application');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('message', data => {
      const m = JSON.parse(data), p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(Error(JSON.stringify(m.error))); else p.resolve(m.result);
    });
    await until(() => run('!!document.querySelector(".sidebar")'), 'UI');
    await run('window.electronAPI.maximize(); true');
    if (process.argv.includes('--quit')) {
      const before = await state();
      await run("setTimeout(() => window.electronAPI.closeWithAction('quit'), 100); true");
      if (before.url) await until(async () => { try { return !(await fetch(before.url + '/v1/health')).ok; } catch { return true; } }, 'owned backend exits with application');
      report.checks.quitStoppedOwnedBackend = true;
    } else if (process.argv.includes('--repair')) {
      const current = await state();
      if (!current.root.includes('Windows 新用户 验证')) throw Error('Repair fault injection is restricted to the disposable QA profile');
      await run(`document.querySelector('button[title="设置"]').click(); true`);
      await until(() => run('!!document.querySelector(".local-runtime-panel")'), 'settings');
      if (current.owned) { await click('停止本机服务'); await waitPhase('ready'); }
      const envFile = path.join(current.root, 'app/backend/.env');
      const sentinel = '# QA environment must survive repair\n';
      fs.writeFileSync(envFile, sentinel);
      const httpxModule = path.join(current.root, 'app/.venv/Lib/site-packages/httpx/__init__.py');
      fs.renameSync(httpxModule, httpxModule + '.qa-backup');
      await click('修复环境');
      const repaired = await waitPhase('ready', 600000);
      if (!fs.existsSync(httpxModule) || fs.readFileSync(envFile, 'utf8') !== sentinel || repaired.owned) throw Error('Repair failed to restore module/preserve configuration/stay stopped');
      await click('启动本机服务');
      await waitPhase('running', 60000);
      report.checks.repair = { restoredMissingModule: true, preservedEnv: true, installOnly: true, backendRestarts: true };
      await screenshot('repaired');
    } else if (process.argv.includes('--resume')) {
      const running = await waitPhase('running');
      const connected = await run(`(() => { const s=JSON.parse(localStorage.getItem('asr-desktop-store')).state.settings; return s.backendConfirmed && s.serverUrl===${JSON.stringify(running.url)}; })()`);
      if (!connected) throw Error('Auto-start did not connect renderer');
      report.checks.restartAutoStart = { phase: running.phase, url: running.url, connected };
      await run(`document.querySelector('button[title="设置"]').click(); true`);
      await screenshot('auto-start-ready');
    } else {
      const initial = await state();
      if (initial.installed) throw Error('A clean QA user profile is required');
      report.checks.initial = initial;
      await click('安装本机环境');
      await until(() => run('!!document.querySelector(".local-runtime-panel")'), 'install panel');
      await screenshot('first-run');
      const start = Date.now();
      await click('只安装环境');
      const installed = await waitPhase('ready', 1200000);
      if (!installed.installed || installed.owned || installed.url) throw Error('Install-only unexpectedly started a service');
      report.checks.cleanInstall = { elapsedMs: Date.now() - start, root: installed.root, owned: installed.owned };
      await click('启动本机服务');
      let running = await waitPhase('running', 60000);
      const health = await (await fetch(running.url + '/v1/health')).json();
      const catalog = await (await fetch(running.url + '/v1/live-voice/catalog')).json();
      if (health.status !== 'ok' || catalog.providers.some(p => p.configured)) throw Error('Health failed or credentials were shipped');
      await until(() => run(`document.querySelector('.local-runtime-panel').textContent.includes('当前已连接')`), 'UI connected');
      report.checks.backend = { health: health.status, configuredProviders: catalog.providers.filter(p => p.configured).length, providerCount: catalog.providers.length, url: running.url };
      await screenshot('installed-running');
      const startedAgain = await run('window.electronAPI.localRuntimeStart()');
      if (startedAgain.url !== running.url) throw Error('Duplicate start spawned a second backend');
      report.checks.idempotentStart = true;
      await click('停止本机服务');
      await waitPhase('ready');
      let alive = false; try { alive = (await fetch(running.url + '/v1/health')).ok; } catch { /* stopped */ }
      if (alive) throw Error('Stopped backend still responds');
      report.checks.stop = true;
      await click('启动本机服务');
      running = await waitPhase('running', 60000);
      if (!running.autoStart) await run('window.electronAPI.localRuntimeSetAutoStart(true)');
      await click('进入实时语音对话');
      await until(() => run('document.querySelector(".agent-model-3d")?.dataset.loaded === "true"'), 'digital human', 30000);
      await click('试听口型');
      const mouth = await until(() => run('Number(document.querySelector(".agent-model-3d")?.dataset.mouth || 0) > .05'), 'PCM-driven lips');
      await click('停止试听');
      report.checks.digitalHuman = { actualMouthMovement: mouth };
      await run(`document.querySelector('button[title="设置"]').click(); true`);
      await screenshot('ready');
    }
    report.passed = true;
  } catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(output, process.argv.includes('--quit') ? 'quit-report.json' : process.argv.includes('--repair') ? 'repair-report.json' : process.argv.includes('--resume') ? 'restart-report.json' : 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    ws?.close();
  }
})();
