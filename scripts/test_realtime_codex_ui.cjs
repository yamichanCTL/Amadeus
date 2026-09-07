// Real original UI -> microphone PCM -> X-ASR -> Codex -> same-session follow-up.
// Run with Electron (ELECTRON_RUN_AS_NODE unset), under Xvfb if no desktop is available.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.runtime', 'realtime-codex-ui', String(Date.now()));
fs.mkdirSync(out, {recursive: true});
const wav = path.join(out, 'speech.wav');
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i',"flite=text='reply with the number five':voice=slt",'-af','adelay=500,apad=pad_dur=30','-ar','16000','-ac','1','-c:a','pcm_s16le',wav]);
app.setPath('userData', path.join(out, 'browser'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({width:1440,height:1100,show:false,webPreferences:{backgroundThrottling:false}});
  const run = source => win.webContents.executeJavaScript(source,true);
  const until = async (expression, timeout = 180000) => {
    const start = Date.now();
    while (Date.now()-start < timeout) { const value = await run(expression); if(value) return value; await delay(150); }
    throw Error('Timed out: '+expression+'\n'+await run("document.querySelector('.realtime-agent-page')?.innerText || document.body.innerText"));
  };
  const click = (selector,text) => run(`(() => {const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)}); if(!el) throw Error('Missing button: '+${JSON.stringify(text)}); el.click();})()`);
  const input = (selector,value) => run(`(() => {const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  try {
    await win.loadURL(process.env.CODEX_UI_URL || 'http://localhost:5173/?e2e=1');
    await until("document.querySelector('.sidebar')",10000);
    await run("[...document.querySelectorAll('.sidebar nav button')].find(el=>el.textContent.includes('设置')).click()");
    await until("document.querySelector('input[placeholder=\"http://your-server-ip:18000\"]')",10000);
    await input('input[placeholder="http://your-server-ip:18000"]','http://localhost:5173');
    await click('button','确认');
    await run("[...document.querySelectorAll('.sidebar nav button')].find(el=>el.textContent.includes('实时对话')).click()");
    await until("document.querySelector('.agent-codex-usage')?.textContent.includes('已连接 Codex')");
    const ttsOff = await run("![...document.querySelectorAll('.agent-config label')].find(el=>el.textContent.includes('自动朗读回复')).querySelector('input').checked");
    if (!ttsOff) throw Error('TTS must be disabled by default');
    await run(`(() => {
      window.__voiceEvents = [];
      window.__ttsCalls = 0;
      const speak = speechSynthesis.speak.bind(speechSynthesis);
      speechSynthesis.speak = (...args) => { window.__ttsCalls++; return speak(...args); };
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args) { super(...args); this.addEventListener('message', e => {
          try { window.__voiceEvents.push(JSON.parse(e.data)); } catch {}
        }); }
      };
    })()`);
    if (process.env.AEC_SIMULATE_CONSTRAINT_FAILURE === '1') {
      await run(`(() => {
        window.__aecConstraintFailures = 0;
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => {
          if (constraints.audio?.echoCancellation?.exact === true) throw new DOMException('Cannot satisfy constraints', 'OverconstrainedError');
          const stream = await getUserMedia(constraints);
          for (const track of stream.getAudioTracks()) {
            const capabilities = track.getCapabilities.bind(track);
            const apply = track.applyConstraints.bind(track);
            track.getCapabilities = () => ({ ...capabilities(), echoCancellation: [true, false, 'all'] });
            track.applyConstraints = async constraints => {
              if (constraints.echoCancellation?.ideal === 'all' || constraints.echoCancellation?.exact === 'all') {
                window.__aecConstraintFailures++;
                throw new DOMException('Cannot satisfy constraints', 'OverconstrainedError');
              }
              return apply(constraints);
            };
          }
          return stream;
        };
      })()`);
    }
    await click('.agent-input-row button','●语音');
    await until("window.__voiceEvents.some(e=>e.type==='partial' && e.text)");
    // Longer than the old automatic 10-second segmentation limit, with a long silence.
    await delay(12500);
    const beforeEnd = await run("({partials:window.__voiceEvents.filter(e=>e.type==='partial').length,finals:window.__voiceEvents.filter(e=>e.type==='final').length,agentEvents:window.__voiceEvents.filter(e=>e.type.startsWith('agent.')).length,endpointing:window.__voiceEvents.find(e=>e.type==='configured')?.endpointing})");
    if (beforeEnd.endpointing !== 'manual' || !beforeEnd.partials || beforeEnd.finals || beforeEnd.agentEvents) throw Error('Premature submission: '+JSON.stringify(beforeEnd));
    await click('.agent-input-row button','●结束语音');
    await until("document.querySelector('.agent-message.assistant small') && !document.querySelector('.agent-input-row input').disabled");
    const voice = await run("({asr:document.querySelector('.agent-message.user p').textContent,reply:[...document.querySelectorAll('.agent-message.assistant p')].at(-1).textContent,usage:document.querySelector('.agent-codex-usage').textContent})");
    if (!/reply with the number five/i.test(voice.asr) || !voice.reply.includes('5')) throw Error('Unexpected real voice response: '+JSON.stringify(voice));
    await input('.agent-input-row input','我刚才让你回复哪个数字？只回复那个数字。');
    await click('.agent-input-row button','发送');
    await until("document.querySelectorAll('.agent-message.assistant small').length === 2 && !document.querySelector('.agent-input-row input').disabled");
    const followup=await run("[...document.querySelectorAll('.agent-message.assistant p')].at(-1).textContent");
    if (!followup.includes('5')) throw Error('Conversation context lost: '+followup);
    const usage=await until("document.querySelector('.agent-codex-usage')?.textContent.includes('2 次调用') && document.querySelector('.agent-codex-usage').textContent");
    await run("document.querySelector('.content').scrollTo(0,0)");
    await delay(500);
    fs.writeFileSync(path.join(out,'original-ui.png'),(await win.webContents.capturePage()).toPNG());
    await click('.agent-dialogue .agent-actions button','清空');
    await until("document.querySelector('.agent-message.assistant p')?.textContent.includes('上下文已清空')");
    const voiceChecks=await run("({finals:window.__voiceEvents.filter(e=>e.type==='final').length,completed:window.__voiceEvents.filter(e=>e.type==='agent.completed').length,ttsCalls:window.__ttsCalls})");
    if (voiceChecks.finals !== 1 || voiceChecks.completed !== 1 || voiceChecks.ttsCalls !== 0) throw Error('Unexpected loop or TTS: '+JSON.stringify(voiceChecks));
    const constraintFailures = await run('window.__aecConstraintFailures || 0');
    if (process.env.AEC_SIMULATE_CONSTRAINT_FAILURE === '1' && constraintFailures !== 1) throw Error('Constraint failure path was not exercised');
    const report={passed:true,constraint_failures_handled:constraintFailures,manual_endpointing:true,tts_off:ttsOff,beforeEnd,voiceChecks,original_ui:true,real_microphone_pipeline:true,real_asr:true,real_codex:true,voice,followup,usage,reset:true};
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({out,...report}));app.exit(0);
  } catch(error) {
    fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG());
    console.error(String(error));app.exit(1);
  }
});
