// Signal-level test of the production PcmStreamer with native WebRTC AEC.
const {app,BrowserWindow}=require('electron');const fs=require('fs');const {spawn}=require('child_process');
const root=process.env.AEC_TEST_DIR;if(!root)throw Error('Run with test_browser_aec.py');const mode=process.env.AEC_TEST_MODE||'on';
app.setPath('userData',root+'/browser-'+mode);app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});try{
win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(true));
win.webContents.session.setPermissionCheckHandler(()=>true);

await win.loadURL('http://localhost:5173/?e2e=1');
const result=await win.webContents.executeJavaScript(`(async()=>{
const {PcmStreamer}=await import('/src/services/audio.ts');
const devices=await navigator.mediaDevices.enumerateDevices();const mic=devices.find(d=>d.kind==='audioinput'&&d.label.includes('${process.env.AEC_TEST_MIC || 'asrapp_aec_mic'}'));if(!mic)throw Error('Test microphone missing: '+JSON.stringify(devices));
const bytes=Uint8Array.from(atob('${fs.readFileSync(root+'/far.wav').toString('base64')}'),x=>x.charCodeAt(0));
const context=new AudioContext({sampleRate:48000});const buffer=await context.decodeAudioData(bytes.buffer);const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);await context.resume();
const chunks=[];let state=null;const pcm=new PcmStreamer((p)=>chunks.push(p.slice()),{requireEchoCancellation:${mode==='on'},onCaptureSettings:s=>state=s});
const raw=${mode==='on'?'undefined':"await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:mic.deviceId},echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false})"};
await pcm.start(mic.deviceId,raw);console.log('AEC_READY');source.start();await new Promise(r=>setTimeout(r,21000));pcm.stop();source.stop();await context.close();
return {state,samples:chunks.flatMap(x=>Array.from(x))};})()`,true);
fs.writeFileSync(root+'/room-'+mode+'.pcm',Buffer.from(new Int16Array(result.samples).buffer));console.log(JSON.stringify({mode,state:result.state,samples:result.samples.length}));app.exit(0);
}catch(e){console.error(e);app.exit(1);}});
