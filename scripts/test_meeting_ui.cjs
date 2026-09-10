// Original UI -> real PCM/X-ASR -> spoken trigger -> isolated Codex explanations.
// Run with Electron, ELECTRON_RUN_AS_NODE unset; Vite 5173 and backend required.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.runtime', 'meeting-ui', String(Date.now()));
fs.mkdirSync(out, { recursive: true });
const wav = path.join(out, 'meeting.wav');
// Deliberately differs from the spoken phrase in width, case and punctuation.
const keyword = 'ＥＸＰＬＡＩＮ， ｔｈｉｓ！';
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  "flite=text='The team is reviewing database changes. Optimistic locking checks a version number before saving changes. For our committee meeting, why do more than half of the voting members need to be present? Explain this. The next topic is holiday travel and airline tickets.':voice=slt",
  '-af', 'adelay=500,apad=pad_dur=90', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
app.setPath('userData', path.join(out, 'browser'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 1200, show: false, webPreferences: { backgroundThrottling: false } });
  const run = async source => {
    try { return await win.webContents.executeJavaScript(source, true); }
    catch (error) { throw Error(String(error) + '\nBrowser script: ' + source); }
  };
  const until = async (expression, timeout = 120000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { const value = await run(expression); if (value) return value; await delay(150); }
    throw Error('Timed out: ' + expression + '\n' + await run('document.body.innerText'));
  };
  const click = (selector, label) => run(`(() => {const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>${selector.includes('.sidebar') ? 'x.textContent.includes' : 'x.textContent.trim() ==='}${selector.includes('.sidebar') ? '(' + JSON.stringify(label) + ')' : JSON.stringify(label)});if(!el)throw Error('Missing '+${JSON.stringify(label)});el.click()})()`);
  const input = (selector, value, tag = 'HTMLInputElement') => run(`(() => {const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${tag}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  try {
    await win.loadURL(process.env.CODEX_UI_URL || 'http://localhost:5173/?e2e=1');
    await until('document.querySelector(".sidebar")', 15000);
    await click('.sidebar nav button', '设置');
    await until('document.querySelector(' + JSON.stringify('input[placeholder="http://your-server-ip:18000"]') + ')', 10000);
    await input('input[placeholder="http://your-server-ip:18000"]', 'http://localhost:5173');
    await click('button', '确认');
    await click('.sidebar nav button', '实时对话');
    await until("document.querySelector('.agent-codex-usage')?.textContent.includes('Codex 配置已读取')");
    await input('select[aria-label="实时对话模式"]', 'meeting', 'HTMLSelectElement');
    await until('document.querySelector(".meeting-assist")');
    await run(`(() => {
      window.__requests=[];window.__responses=[];window.__events=[];window.__frames=0;window.__tts=0;
      const fetch=window.fetch.bind(window);
      window.fetch=async (url,init)=>{
        if(!String(url).endsWith('/explanations'))return fetch(url,init);
        window.__requests.push(JSON.parse(init.body));const frames=window.__frames;
        const response=await fetch(url,init);window.__responses.push({body:await response.clone().json(),frames:window.__frames-frames});return response;
      };
      const WS=window.WebSocket;
      window.WebSocket=class extends WS {
        constructor(...args){super(...args);this.addEventListener('message',e=>{try{window.__events.push(JSON.parse(e.data))}catch{}})}
        send(data){if(typeof data!=='string')window.__frames++;return super.send(data)}
      };
      const speak=speechSynthesis.speak.bind(speechSynthesis);speechSynthesis.speak=(...args)=>{window.__tts++;return speak(...args)};
      [...document.querySelectorAll('.meeting-assist label')].find(x=>x.textContent.includes('语音口令触发')).querySelector('input').click();
    })()`);
    await input('input[aria-label="解释口令"]', keyword);
    await input('textarea[aria-label="预置提示词"]', '请优先解释委员会会议的决策程序和业务含义，用通俗中文解释。', 'HTMLTextAreaElement');
    await input('textarea[aria-label="关注要点"]', '法定人数的作用\n对表决有效性的影响', 'HTMLTextAreaElement');
    await input('input[aria-label="回看时长（秒）"]', '90');
    await input('input[aria-label="重点关注末尾（秒）"]', '15');
    await input('select[aria-label="末尾关注程度"]', '5', 'HTMLSelectElement');
    await run(`(() => {
      [...document.querySelectorAll('button')].find(x=>x.textContent.startsWith('设置快捷键')).click();
      window.dispatchEvent(new KeyboardEvent('keydown',{ctrlKey:true,shiftKey:true,code:'KeyJ',bubbles:true}));
    })()`);
    await click('.meeting-assist button', '开始旁听');
    await until('window.__responses.length===1');
    const first = await run('window.__responses[0]');
    if (first.body.result?.status !== 'completed' || !/voting members/i.test(first.body.target) || /explain this/i.test(first.body.target) || first.frames <= 0 || !/半数|多数|法定人数|quorum/i.test(first.body.result.text)) throw Error('Spoken explanation failed: ' + JSON.stringify(first));
    await delay(1500);
    if (await run('window.__requests.length') !== 1) throw Error('Repeated ASR triggered duplicate explanations');
    await input('textarea[aria-label="预置提示词"]', '请解释下面的软件缓存概念。', 'HTMLTextAreaElement');
    await input('textarea[aria-label="关注要点"]', '缓存有效期', 'HTMLTextAreaElement');
    await input('textarea[aria-label="本次解释原文"]', 'A cache entry expires after a time to live.', 'HTMLTextAreaElement');
    await click('.meeting-assist button', '解释这段原话');
    await until('window.__responses.length===2');
    const evidence = await run(`({requests:window.__requests,responses:window.__responses,frames:window.__frames,tts:window.__tts,
      finals:window.__events.filter(e=>e.type==='final').length,agentEvents:window.__events.filter(e=>e.type.startsWith('agent.')).length,
      endpointing:window.__events.find(e=>e.type==='configured')?.endpointing,listening:document.querySelector('.meeting-assist [role=status]').textContent,
      transcript:document.querySelector('textarea[aria-label="会议实时转写"]').value})`);
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    const second = evidence.responses[1].body.result;
    if (second.status !== 'completed' || second.session_id === first.body.result.session_id || /法定人数|quorum|乐观锁|optimistic locking/i.test(second.text)) throw Error('Explanation isolation failed');
    // ASR may merge the earlier sentences: background can then be in target.
    const request = evidence.requests[0];
    if (request.focus !== 'recent_window' || !/voting members/i.test(request.target) || !/database changes/i.test(request.preceding_context + request.target) || /holiday|airline|explain this/i.test(request.target) || 'following_context' in request || request.recent_weight !== 5 || request.lookback_seconds !== 90 || !request.preset_prompt.includes('委员会') || !request.focus_points.includes('法定人数') || evidence.requests[1].focus !== 'target') throw Error('Meeting focus/context routing failed');
    if (!(await run('localStorage.getItem("amadeus.meeting.preferences.v2")')).includes('Ctrl+Shift+KeyJ')) throw Error('Shortcut was not saved');
    if (evidence.requests.some(x=>x.context || x.session_id) || evidence.finals || evidence.agentEvents || evidence.tts || evidence.endpointing!=='manual' || !evidence.listening.includes('持续旁听中')) throw Error('Meeting stream/control invariant failed');
    await click('.meeting-assist button', '停止旁听');
    const frames = await run('window.__frames');
    await delay(500);
    if (await run('window.__frames') !== frames || await run('window.__requests.length') !== 2) throw Error('Stop did not stop capture or submitted extra explanation');
    fs.writeFileSync(path.join(out, 'meeting.png'), (await win.webContents.capturePage()).toPNG());
    const report = { passed: true, real_asr: true, real_codex: true, keyword, ...evidence };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, passed: true, targets: evidence.requests.map(x=>x.target), replies: evidence.responses.map(x=>x.body.result.text), continuous_audio: true }));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error(String(error));app.exit(1);
  }
});
