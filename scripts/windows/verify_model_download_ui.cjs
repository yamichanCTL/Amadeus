// Inspect only our disposable Amadeus Electron QA instance, not the user's browser.
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('../../frontend/desktop/node_modules/ws');
const output = path.resolve(__dirname, '../../.runtime/model-download-preview');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, seq = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function run(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || 'Renderer error');
  return r.result.value;
}
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9233/json/list')).json();
  const page = pages.find(p => p.type === 'page' && p.url.includes('index.html'));
  if (!page) throw Error('QA page not found');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', data => { const m = JSON.parse(data), p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  let state = await run('window.electronAPI.localRuntimeStatus()');
  if (!state.root.includes('model-download-preview')) throw Error('Wrong QA profile');
  if (process.argv.includes('--quit')) {
    await run("setTimeout(() => window.electronAPI.closeWithAction('quit'), 100); true");
    console.log('QA app quit requested'); return;
  }
  if (process.argv.includes('--repair')) {
    await run('window.electronAPI.localRuntimeStop()');
    // Source updates need to be copied; installation runs independently of the CDP timeout.
    await run('window.electronAPI.localRuntimeInstall().catch(() => {}); true');
    for (let i = 0; i < 120; i++) {
      await sleep(1000); state = await run('window.electronAPI.localRuntimeStatus()');
      if (state.phase === 'ready') break;
      if (state.phase === 'error') throw Error(state.error || state.message);
    }
  }
  state = await run('window.electronAPI.localRuntimeStart()');
  fs.writeFileSync(path.join(output, 'ui-runtime.json'), JSON.stringify({ url: state.url, phase: state.phase }, null, 2));
  if (state.phase !== 'running') throw Error(state.error || state.message);
  await run(`(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('模型管理')); if (!b) throw Error('Models navigation missing'); b.click(); return true; })()`);
  await sleep(2000);
  const info = await run(`(() => { const s=document.querySelector('select[aria-label="要下载的模型"]'); if(!s) throw Error('Model downloader missing'); s.value='whisper-tiny'; s.dispatchEvent(new Event('change',{bubbles:true})); return {models:[...s.options].map(o=>o.textContent), count:s.options.length}; })()`);
  if (info.count !== 10) throw Error('Expected 10 model variants');
  await sleep(500);
  info.sources = await run(`Array.from(document.querySelector('select[aria-label="模型下载来源"]').options).map(o=>o.textContent)`);
  info.panel = await run(`document.querySelector('.model-downloads').textContent`);
  await send('Page.bringToFront'); await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, 'model-downloads.png'), Buffer.from(shot.data, 'base64'));
  fs.writeFileSync(path.join(output, 'ui-report.json'), JSON.stringify({ passed: true, url: state.url, ...info }, null, 2));
  console.log(JSON.stringify({ passed: true, url: state.url, ...info }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => ws?.close());
