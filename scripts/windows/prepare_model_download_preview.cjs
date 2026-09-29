// Prepare only the isolated ASR-download QA profile, never the user's active backend.
const path = require('node:path');
const fs = require('node:fs');
const { LocalRuntimeManager } = require('../../frontend/desktop/dist-electron/local-runtime.js');
const root = path.resolve(__dirname, '../..');
const destination = path.join(root, '.runtime/model-download-preview/local-runtime');
let phase = '';
const manager = new LocalRuntimeManager({ root: destination, bundlePath: root, uvPath: path.join(root, '.runtime/windows-bootstrap/uv.exe'), onChange(state) {
  const next = `${state.phase}: ${state.message}`;
  if (next !== phase) { console.log(next); phase = next; }
} });
(async () => {
  try {
    let state = await manager.install();
    if (state.phase !== 'ready') throw Error(state.error || state.message);
    state = await manager.start();
    if (state.phase !== 'running') throw Error(state.error || state.message);
    state = await manager.installExtra('whisper');
    if (state.phase !== 'running') throw Error(state.error || state.message);
    await manager.setAutoStart(true);
    fs.writeFileSync(path.join(destination, 'runtime-extra-qa.json'), JSON.stringify({ passed: true, extra: 'whisper', root: destination }, null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { await manager.dispose(); }
})();
