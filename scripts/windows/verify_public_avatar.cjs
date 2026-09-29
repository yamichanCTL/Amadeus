// Only the explicitly launched disposable Electron instance on port 9234 is driven.
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('../../frontend/desktop/node_modules/ws');
const output = path.resolve(__dirname, '../../.runtime/public-release-qa');
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, sequence = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function run(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || 'Renderer failed');
  return r.result.value;
}
async function until(expression, label) {
  for (let i = 0; i < 100; i++) { const v = await run(expression); if (v) return v; await delay(150); }
  throw Error('Timed out: ' + label);
}
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9234/json/list')).json();
  const page = pages.find(p => p.type === 'page' && p.url.includes('index.html'));
  if (!page) throw Error('QA page missing');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', data => { const m = JSON.parse(data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); });
  const runtime = await run('window.electronAPI.localRuntimeStatus()');
  if (!runtime.root.includes('public-release-qa')) throw Error('Wrong user profile');
  if (process.argv.includes('--quit')) { await run("setTimeout(()=>window.electronAPI.closeWithAction('quit'),100); true"); return; }
  const state = await run('window.electronAPI.localAvatarStatus()');
  if (process.argv.includes('--open-import')) {
    await run('window.electronAPI.localAvatarImport().then(s=>{document.body.dataset.importResult=JSON.stringify(s)}).catch(e=>{document.body.dataset.importError=String(e)}); true');
    console.log('Native import dialog requested'); return;
  }
  const loaded = process.argv.includes('--loaded');
  if (state.available !== loaded) throw Error('Unexpected avatar presence');
  const check = { available: state.available, name: state.name, revision: state.revision };
  if (loaded) {
    await until('document.querySelector(".agent-model-3d")?.dataset.loaded === "true"', 'model render');
    check.morphs = await run('Number(document.querySelector(".agent-model-3d").dataset.morphCount)');
    await run(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='试听口型'); if(!b)throw Error('Missing rehearsal'); b.click(); return true})()`);
    check.audioMovesMouth = await until('Number(document.querySelector(".agent-model-3d")?.dataset.mouth || 0) > .05', 'PCM lip sync');
    await run('window.electronAPI.setPetEnabled(true)');
    let petPage;
    for (let i = 0; i < 60; i++) {
      petPage = (await (await fetch('http://127.0.0.1:9234/json/list')).json()).find(p => p.url.includes('pet.html'));
      if (petPage) break;
      await delay(150);
    }
    if (!petPage) throw Error('Pet window missing');
    const mainSocket = ws, petSocket = new WebSocket(petPage.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { petSocket.once('open', resolve); petSocket.once('error', reject); });
    petSocket.on('message', data => { const m = JSON.parse(data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); });
    try {
      ws = petSocket;
      check.petLoaded = await until('document.querySelector("#petCanvas")?.dataset.loaded === "true"', 'imported pet');
      check.petAudioMovesMouth = await until('Number(document.querySelector("#petCanvas")?.dataset.mouth || 0) > .05', 'pet lip sync');
    } finally { ws = mainSocket; petSocket.close(); }
    await run(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='停止试听')?.click(); return true})()`);
    await run('window.electronAPI.setPetEnabled(false)');
  } else {
    check.importButton = await until(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='导入本地 GLB')`, 'empty state import');
    check.noModel = await run('document.querySelector(".agent-model-3d")?.dataset.loaded !== "true"');
  }
  await send('Page.bringToFront'); await delay(300);
  const picture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, loaded ? 'imported-avatar.png' : 'no-avatar.png'), Buffer.from(picture.data, 'base64'));
  fs.writeFileSync(path.join(output, loaded ? 'import-report.json' : 'empty-report.json'), JSON.stringify({ passed: true, ...check }, null, 2));
  console.log(JSON.stringify({ passed: true, ...check }, null, 2));
})().catch(e=>{ console.error(e); process.exitCode=1; }).finally(()=>ws?.close());
