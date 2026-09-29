/* Inspect only the newly launched Amadeus test process on its own local CDP port.
 * Requires --use-fake-device-for-media-stream: never captures the user's mic.
 * No API keys, localStorage contents, or remote user transcripts are logged.
 */
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('../../frontend/desktop/node_modules/ws');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/digital-human-integration');
const address = 'http://127.0.0.1:9231';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { passed: false, checks: {}, source: 'packaged Electron, real PCM playback, actual Three morph weights', microphone: 'synthetic silent fixture' };
fs.mkdirSync(output, { recursive: true });

async function targets() { return (await (await fetch(address + '/json/list')).json()).filter(item => item.type === 'page'); }
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  ws.on('message', text => {
    const message = JSON.parse(text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 12000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    async run(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Page evaluation failed');
      return result.result.value;
    },
    close() { ws.close(); },
  };
}
async function until(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await check(); if (value) return value; await delay(75); }
  throw new Error('Timed out: ' + label);
}
const button = (client, label) => client.run(`(() => {
  const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim().endsWith(${JSON.stringify(label)}));
  if (!button || button.disabled) throw Error('Button unavailable: ' + ${JSON.stringify(label)});
  button.click(); return true;
})()`);
const mainMouth = client => client.run(`(() => { const c = document.querySelector('.agent-model-3d'); return { loaded:c?.dataset.loaded, count:Number(c?.dataset.morphCount||0), mouth:Number(c?.dataset.mouth||0), voiced:c?.dataset.voiced, error:document.querySelector('.agent-model-error')?.textContent || '' }; })()`);
const petMouth = client => client.run(`({ loaded:!!window.__petReady, count:window.__petStats?.morphs || 0, mouth:window.__petStats?.mouthMax || 0, voiced:window.__petStats?.voiced || false })`);
async function screenshot(client, name) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
}

(async () => {
  let main, pet;
  try {
    const target = await until(async () => (await targets()).find(item => item.url.includes('/index.html')), 'main target');
    main = await connect(target);
    await until(() => main.run('!!document.querySelector(".sidebar")'), 'application');
    await main.run('window.electronAPI.maximize(); true');
    await delay(250);
    // Dedicated persistent integration profile only; provider keys live in backend.
    await main.run(`(() => {
      const saved=JSON.parse(localStorage.getItem('asr-desktop-store') || '{"state":{},"version":44}');
      saved.state.settings={...saved.state.settings,serverUrl:'http://127.0.0.1:8000',backendConfirmed:true,
        agentPetEnabled:true,agentRealtimeProvider:'gemini_live',agentAutoSpeak:false,agentHandsFree:false,
        audioInputDeviceId:'',audioOutputDeviceId:'',keepRunningInBackground:true};
      saved.version=44; localStorage.setItem('asr-desktop-store',JSON.stringify(saved));
      location.hash='#realtime'; location.reload(); return true;
    })()`);
    await until(async () => (await mainMouth(main)).loaded === 'true', 'main model load', 30000);
    const petTarget = await until(async () => (await targets()).find(item => item.url.includes('/pet.html')), 'pet target');
    pet = await connect(petTarget);
    await until(async () => (await petMouth(pet)).loaded, 'pet model load', 30000);
    const initial = { main: await mainMouth(main), pet: await petMouth(pet) };
    if (initial.main.count !== 12 || initial.pet.count !== 12 || initial.main.mouth || initial.pet.mouth) throw Error('Model/morph/neutral mismatch');
    report.checks.model = initial;

    await button(main, '试听口型');
    const samples = [];
    let captured = false;
    const start = Date.now();
    while (Date.now() - start < 4200) {
      const [m, p] = await Promise.all([mainMouth(main), petMouth(pet)]);
      samples.push({ elapsedMs: Date.now() - start, main: m.mouth, pet: p.mouth });
      if (!captured && m.mouth > .08 && p.mouth > .08) {
        await screenshot(main, 'amadeus-speaking'); await screenshot(pet, 'desktop-pet-speaking'); captured = true;
      }
      await delay(45);
    }
    const maxima = { main: Math.max(...samples.map(row => row.main)), pet: Math.max(...samples.map(row => row.pet)) };
    if (!captured || maxima.main < .08 || maxima.pet < .08) throw Error('No actual speech morph animation');
    report.checks.preview = { maxima, samples };
    const stopAt = Date.now();
    await button(main, '停止试听');
    await until(async () => (await mainMouth(main)).mouth === 0 && (await petMouth(pet)).mouth === 0, 'stop closure', 2000);
    report.checks.manual_stop = { observedClosureMs: Date.now() - stopAt, note: 'UI stop to inspected rendered weights, not acoustic/model barge-in latency' };
    await delay(500);
    if ((await petMouth(pet)).mouth !== 0) throw Error('Cancelled audio revived mouth');

    await button(main, '试听口型');
    await main.run('window.electronAPI.minimize(); true');
    let hiddenMax = 0;
    const hiddenAt = Date.now();
    while (Date.now() - hiddenAt < 2800) { hiddenMax = Math.max(hiddenMax, (await petMouth(pet)).mouth); await delay(65); }
    await button(main, '停止试听');
    if (hiddenMax < .08) throw Error('Minimized main window stopped pet lip sync');
    report.checks.minimized = { petMax: hiddenMax };
    // Electron does not expose Chromium's Browser window-management domain.
    // Use Amadeus' own existing window control to restore the minimized window.
    await main.run('window.electronAPI.maximize(); true');

    if (process.argv.includes('--live')) {
      await button(main, '开始全双工');
      await until(() => main.run(`!![...document.querySelectorAll('button')].find(el=>el.textContent.trim().endsWith('结束全双工')&&!el.disabled)`), 'Gemini connection', 25000);
      await main.run(`(() => {
        const input=document.querySelector('input[aria-label="对话消息"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'请只说一句：你好，口型连接成功。');
        input.dispatchEvent(new Event('input',{bubbles:true})); return true;
      })()`);
      await button(main, '发送');
      let liveMaxMain = 0, liveMaxPet = 0;
      const liveAt = Date.now();
      await until(async () => {
        const [m,p] = await Promise.all([mainMouth(main),petMouth(pet)]);
        liveMaxMain=Math.max(liveMaxMain,m.mouth); liveMaxPet=Math.max(liveMaxPet,p.mouth);
        return liveMaxMain > .05 && liveMaxPet > .05;
      }, 'actual Gemini returned audio and animated both windows', 30000);
      report.checks.live_gemini = { mainMax: liveMaxMain, petMax: liveMaxPet, firstObservedBothMs: Date.now()-liveAt, syntheticMic:true };
      await button(main, '停止朗读');
      await until(async () => (await petMouth(pet)).mouth === 0, 'live interrupt closure', 2000);
      await button(main, '结束全双工');
    }
    report.passed = true;
    await screenshot(main, 'amadeus-ready');
  } catch (error) {
    report.error = String(error.stack || error);
    if (main) {
      try { report.pageError = await main.run(`document.querySelector('.agent-error')?.textContent || document.querySelector('.error-text')?.textContent || ''`); } catch {}
    }
  } finally {
    if (main) {
      try { await main.run(`(() => { for (const label of ['停止试听','结束全双工']) {
        const b=[...document.querySelectorAll('button')].find(el=>el.textContent.trim().endsWith(label));
        if (b && !b.disabled) b.click(); } return true; })()`); } catch {}
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed:report.passed, checks:Object.keys(report.checks), error:report.error, pageError:report.pageError }));
    main?.close(); pet?.close();
    process.exitCode = report.passed ? 0 : 1;
  }
})();
