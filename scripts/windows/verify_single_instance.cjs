// Run after: cd frontend/desktop && npx tsc -p tsconfig.node.json
// Uses only disposable Electron children and private profiles in .runtime.
// It never connects to or stops the user's running Amadeus application.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repository = path.resolve(__dirname, '../..');
const helper = path.join(repository, 'frontend/desktop/dist-electron/single-instance.js');
const fixture = path.join(__dirname, 'single_instance_fixture.cjs');
const runtime = process.env.AMADEUS_TEST_ELECTRON || path.join(repository, '.runtime/electron-runtime/electron.exe');
const output = path.join(repository, '.runtime', `single-instance-${Date.now()}`);
const alternateFixture = path.join(output, 'alternate-entry', 'main.cjs');
const firstRuntime = path.join(output, 'first-installation', 'electron.exe');
const secondRuntime = path.join(output, 'second-installation', 'electron.exe');
const children = [];
const cases = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sequence = 0;

function events(child) {
  try {
    return fs.readFileSync(child.logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
}

function launch(root, suffix, { alternate = false, windowDelay = 0 } = {}) {
  const id = `instance-${suffix}`;
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(alternate ? secondRuntime : firstRuntime, [
    `--fixture-root=${root}`, `--fixture-id=${id}`, `--lock-helper=${helper}`,
    `--window-delay=${windowDelay}`, '--disable-gpu', '--no-first-run'],
  { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { child, id, root, logFile: path.join(root, `${id}.jsonl`), exited: false, exitCode: null };
  children.push(record);
  const stdout = fs.createWriteStream(path.join(root, `${id}.stdout.log`));
  const stderr = fs.createWriteStream(path.join(root, `${id}.stderr.log`));
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.on('error', (error) => { record.error = String(error); record.exited = true; });
  child.on('exit', (code, signal) => { record.exited = true; record.exitCode = code; record.signal = signal; });
  return record;
}

const waitEvent = (child, event) => until(() => {
  const found = events(child).find((item) => item.event === event);
  if (!found && child.exited) throw new Error(`${child.id} exited before ${event}: ${child.error || child.exitCode}`);
  return found;
}, `${child.id} ${event}`);
const waitExit = (child) => until(() => child.exited, `${child.id} exit`);
function namespace(name) {
  const root = path.join(output, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function prepareRuntime(executable, entrypoint) {
  // Hardlinks give genuine different EXE locations without copying hundreds of
  // megabytes. No shared runtime file is modified by the fixture.
  const destination = path.dirname(executable);
  fs.mkdirSync(destination, { recursive: true });
  const linkTree = (source, target) => {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isDirectory()) linkTree(from, to);
      else if (entry.isFile()) fs.linkSync(from, to);
    }
  };
  for (const entry of fs.readdirSync(path.dirname(runtime), { withFileTypes: true })) {
    if (entry.name === 'resources') continue;
    const source = path.join(path.dirname(runtime), entry.name);
    const target = path.join(destination, entry.name === path.basename(runtime) ? 'electron.exe' : entry.name);
    if (entry.isDirectory()) linkTree(source, target);
    else if (entry.isFile()) fs.linkSync(source, target);
  }
  const appDirectory = path.join(destination, 'resources', 'app');
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'amadeus-single-instance-fixture', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(appDirectory, 'main.cjs'), `require(${JSON.stringify(entrypoint)});\n`);
}
async function command(child, action, extra = {}) {
  const id = ++sequence;
  const commandFile = path.join(child.root, `${child.id}.command.json`);
  const temporary = `${commandFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ id, action, ...extra }));
  fs.renameSync(temporary, commandFile);
  if (action === 'quit') return;
  return until(() => events(child).find((item) => item.event === 'command' && item.command === id), `${child.id} ${action}`);
}
async function rejectDuplicate(child) {
  const lock = await waitEvent(child, 'lock');
  assert.equal(lock.acquired, false, 'Duplicate must not acquire the lock');
  assert.equal(lock.userData, lock.profile, 'Profile must be restored even when rejected');
  await waitExit(child);
  assert.equal(child.exitCode, 0, child.error || 'Duplicate should exit normally');
  assert.equal(events(child).some((item) => item.event === 'ready' || item.event === 'window-ready'), false,
    'Rejected process must not enter application startup or create windows');
}
async function ownerReady(child) {
  const lock = await waitEvent(child, 'lock');
  assert.equal(lock.acquired, true);
  assert.equal(lock.userData, lock.profile, 'Actual profile must survive lock acquisition');
  await waitEvent(child, 'window-ready');
  return lock;
}
async function quit(child) {
  await command(child, 'quit');
  await waitExit(child);
  assert.equal(child.exitCode, 0);
}

(async () => {
  if (process.platform !== 'win32') throw new Error('This Windows integration check requires Windows');
  assert.ok(fs.existsSync(runtime), 'Electron runtime missing; set AMADEUS_TEST_ELECTRON');
  assert.ok(fs.existsSync(helper), 'Compile electron/single-instance.ts before running');
  fs.mkdirSync(path.dirname(alternateFixture), { recursive: true });
  fs.writeFileSync(alternateFixture, `require(${JSON.stringify(fixture)});\n`);
  prepareRuntime(firstRuntime, fixture);
  prepareRuntime(secondRuntime, alternateFixture);

  const profileRoot = namespace('profiles-and-activation');
  const owner = launch(profileRoot, 'owner');
  const ownerLock = await ownerReady(owner);
  const hidden = await command(owner, 'hide');
  assert.equal(hidden.visible, false);
  const duplicate = launch(profileRoot, 'different-profile', { alternate: true });
  await rejectDuplicate(duplicate);
  const activated = await waitEvent(owner, 'activated');
  assert.equal(activated.visible, true);
  assert.equal(activated.minimized, false);
  assert.equal(activated.hasLock, true);
  cases.push({ name: 'different-profile-and-executable-location-hidden-activation', passed: true, focused: activated.focused });

  const minimized = await command(owner, 'minimize');
  assert.equal(minimized.minimized, true);
  const previousActivations = events(owner).filter((item) => item.event === 'activated').length;
  await rejectDuplicate(launch(profileRoot, 'minimized-relaunch'));
  const restored = await until(() => events(owner).filter((item) => item.event === 'activated')[previousActivations], 'minimized restore');
  assert.equal(restored.visible, true);
  assert.equal(restored.minimized, false);
  cases.push({ name: 'minimized-activation', passed: true, focused: restored.focused });
  await quit(owner);

  const raceRoot = namespace('concurrent-startup');
  const competitors = ['one', 'two', 'three'].map((suffix, index) => launch(raceRoot, suffix,
    { alternate: index === 1, windowDelay: 3500 }));
  await Promise.all(competitors.map((child) => waitEvent(child, 'lock')));
  const winners = competitors.filter((child) => events(child).find((item) => item.event === 'lock').acquired);
  assert.equal(winners.length, 1, 'Exactly one concurrent process may win');
  const winner = winners[0];
  await Promise.all(competitors.filter((child) => child !== winner).map(rejectDuplicate));
  await ownerReady(winner);
  const raceActivation = await waitEvent(winner, 'activated');
  assert.equal(raceActivation.visible, true);
  assert.ok(events(winner).some((item) => item.event === 'second-instance' && item.queued), 'Early activation should be queued');
  cases.push({ name: 'concurrent-startup-and-early-activation', passed: true, winner: winner.id });
  await quit(winner);

  const crashRoot = namespace('crash-restart');
  const crashOwner = launch(crashRoot, 'crash-owner');
  await ownerReady(crashOwner);
  crashOwner.child.kill('SIGKILL');
  await waitExit(crashOwner);
  const recovered = launch(crashRoot, 'recovered', { alternate: true });
  await ownerReady(recovered);
  cases.push({ name: 'crashed-owner-restart-no-stale-lock', passed: true });
  await quit(recovered);

  const cleanupRoot = namespace('delayed-cleanup');
  const cleanupOwner = launch(cleanupRoot, 'cleanup-owner');
  await ownerReady(cleanupOwner);
  await command(cleanupOwner, 'quit', { delay: 3500 });
  await waitEvent(cleanupOwner, 'cleanup-started');
  await rejectDuplicate(launch(cleanupRoot, 'during-cleanup', { alternate: true }));
  const cleanupDone = await waitEvent(cleanupOwner, 'cleanup-finished');
  assert.equal(cleanupDone.hasLock, true, 'Lock must remain held through asynchronous cleanup');
  await waitExit(cleanupOwner);
  const afterCleanup = launch(cleanupRoot, 'after-cleanup');
  await ownerReady(afterCleanup);
  await quit(afterCleanup);
  cases.push({ name: 'lock-held-until-cleanup-and-process-exit', passed: true });

  const report = { passed: true, runtimeVersion: ownerLock.electronVersion,
    checkedAt: new Date().toISOString(), cases, output,
    scope: 'Real Electron native lock and disposable fixture lifecycle; no existing user applications controlled.' };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  fs.mkdirSync(output, { recursive: true });
  const report = { passed: false, error: error.stack || String(error), cases, output,
    children: children.map(({ id, error, exited, exitCode, signal }) => ({ id, error, exited, exitCode, signal })) };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  // Only children spawned by this script are eligible for cleanup.
  for (const child of children.filter((item) => !item.exited)) {
    try { await command(child, 'quit'); } catch { /* failed startup has no command reader */ }
  }
  await delay(300);
  for (const child of children.filter((item) => !item.exited)) child.child.kill('SIGKILL');
});
