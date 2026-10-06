// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { StorageLayout, managedRuntimeEnvironment, managedStoragePaths } from './storage-layout'

let fixture: string
let userData: string
let installDir: string
const fixtureParent = path.resolve(__dirname, '../../../.runtime/storage-layout-tests')
const noProcesses = async () => undefined
const has = async (target: string) => { try { await fs.lstat(target); return true } catch { return false } }
const make = () => new StorageLayout({ userData, installDir })
const write = async (target: string, data = 'fixture') => { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data) }
const oldRuntime = () => path.join(userData, 'local-runtime')
const oldMarker = async () => write(path.join(oldRuntime(), 'installation.json'), JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), installedAt: '2026-10-05T00:00:00.000Z' }))

beforeEach(async () => {
  await fs.mkdir(fixtureParent, { recursive: true })
  fixture = await fs.mkdtemp(path.join(fixtureParent, 'case-'))
  userData = path.join(fixture, 'profile')
  installDir = path.join(fixture, 'Programs', 'Amadeus')
})
afterEach(async () => {
  vi.restoreAllMocks()
  // Only fixture directories created by this suite are eligible for recursive removal.
  if (path.dirname(path.resolve(fixture)) !== fixtureParent || !path.basename(fixture).startsWith('case-')) throw new Error('Unsafe fixture cleanup')
  await fs.rm(fixture, { recursive: true, force: true })
})

describe('managed data layout', () => {
  it('places new large data beside the install, retaining only a small pointer in the profile', async () => {
    const state = await make().initialize()
    expect(state.mode).toBe('managed')
    expect(state.root).toBe(path.join(fixture, 'Programs', 'AmadeusData'))
    expect(state.runtimeRoot).toBe(path.join(state.root, 'runtime'))
    expect(await fs.readdir(userData)).toEqual(['storage-pointer.json'])
    expect(await has(oldRuntime())).toBe(false)
    expect(JSON.stringify(state)).not.toContain('owner')
    expect((await make().initialize()).root).toBe(state.root)
  })

  it('redirects every large download/cache/model/data setting to the chosen root', () => {
    const paths = managedStoragePaths(path.join(fixture, 'chosen'))
    const env = managedRuntimeEnvironment(paths)
    for (const [key, value] of Object.entries(env)) {
      if (key === 'DATABASE_URL') expect(value).toBe(`sqlite+aiosqlite:///${path.join(paths.backendDataRoot, 'amadeus.db').replace(/\\/g, '/')}`)
      else expect(path.relative(paths.root, value)).not.toMatch(/^\.\./)
    }
    expect(env.HF_HUB_CACHE).toBe(env.HUGGINGFACE_HUB_CACHE)
    expect(env.TRANSFORMERS_CACHE).toBe(env.HF_HUB_CACHE)
    expect(env.UV_CACHE_DIR).toBe(path.join(paths.cacheRoot, 'uv'))
    expect(env.FORMALASR_MODEL_DIR).toBe(path.join(paths.modelsRoot, 'FormalASR-1.7B'))
    expect(env.X_ASR_MODEL_DIR).toBe(path.join(paths.modelsRoot, 'x-asr', 'chunk-960ms-model'))
    expect(env.TEMP).toBe(paths.tempRoot)
  })

  it('keeps the original venv/model paths until an explicit new location is selected', async () => {
    await oldMarker()
    const venvFile = path.join(oldRuntime(), 'app', '.venv', 'pyvenv.cfg')
    const modelFile = path.join(oldRuntime(), 'models', 'FormalASR-1.7B', 'weights.fixture')
    await write(venvFile, 'absolute-existing-python-location')
    await write(modelFile, 'existing-weight-fixture')
    const layout = make()
    const previous = await layout.initialize()
    expect(previous.mode).toBe('legacy')
    expect(previous.runtimeRoot).toBe(oldRuntime())
    expect(layout.paths()).toBeUndefined()
    const state = await layout.selectParent(path.join(fixture, 'new-drive'))
    expect(state.mode).toBe('managed')
    expect(state.legacyPaths).toContainEqual(expect.objectContaining({ path: oldRuntime(), kind: 'legacy-runtime', canClear: true }))
    expect(await fs.readFile(venvFile, 'utf8')).toBe('absolute-existing-python-location')
    expect(await fs.readFile(modelFile, 'utf8')).toBe('existing-weight-fixture')
    expect(await has(path.join(state.runtimeRoot, 'app', '.venv'))).toBe(false)
    expect(await has(path.join(state.modelsRoot, 'FormalASR-1.7B'))).toBe(false)
  })

  it('uses the new default for an old logs-only shell and retains its files untouched', async () => {
    await write(path.join(oldRuntime(), 'logs', 'backend.log'), 'old-log-fixture')
    await write(path.join(oldRuntime(), 'preferences.json'), '{"autoStart":false}')
    const layout = make()
    const state = await layout.initialize()
    expect(state.mode).toBe('managed')
    expect(state.root).toBe(path.join(fixture, 'Programs', 'AmadeusData'))
    expect(state.legacyPaths).toContainEqual(expect.objectContaining({ path: oldRuntime(), canClear: false }))
    expect(await fs.readFile(path.join(oldRuntime(), 'logs', 'backend.log'), 'utf8')).toBe('old-log-fixture')
    expect(await fs.readFile(path.join(oldRuntime(), 'preferences.json'), 'utf8')).toBe('{"autoStart":false}')
    expect((await make().initialize()).root).toBe(state.root)
  })

  it('retains an incomplete installation with real files even when no installation marker exists', async () => {
    await write(path.join(oldRuntime(), 'logs', 'backend.log'))
    await write(path.join(oldRuntime(), 'app', '.venv', 'pyvenv.cfg'), 'partial-venv-fixture')
    await write(path.join(oldRuntime(), 'cache', 'partial-download'), 'partial-download-fixture')
    const state = await make().initialize()
    expect(state.mode).toBe('legacy')
    expect(state.runtimeRoot).toBe(oldRuntime())
    expect(await has(state.defaultRoot)).toBe(false)
    expect(await fs.readFile(path.join(oldRuntime(), 'app', '.venv', 'pyvenv.cfg'), 'utf8')).toBe('partial-venv-fixture')
    expect(await fs.readFile(path.join(oldRuntime(), 'cache', 'partial-download'), 'utf8')).toBe('partial-download-fixture')
  })

  it('refuses an occupied directory, installer directory and paths outside the listed roots', async () => {
    const layout = make()
    const current = await layout.initialize()
    const occupied = path.join(fixture, 'other')
    await write(path.join(occupied, 'AmadeusData', 'user-document.txt'), 'do-not-adopt')
    await expect(layout.selectParent(occupied)).rejects.toThrow('不是空目录')
    await expect(layout.selectParent(installDir)).rejects.toThrow('安装目录')
    await expect(layout.selectParent(userData)).rejects.toThrow('AppData')
    expect(() => layout.allowedPath(fixture)).toThrow('只允许')
    expect(layout.snapshot().root).toBe(current.root)
    expect(await fs.readFile(path.join(occupied, 'AmadeusData', 'user-document.txt'), 'utf8')).toBe('do-not-adopt')
  })

  it('can clear a retained owned root without touching the active root or external caches', async () => {
    const layout = make()
    const first = await layout.initialize()
    await write(path.join(first.modelsRoot, 'fixture', 'weight'), 'old-model')
    await write(path.join(fixture, 'shared-huggingface', 'weight'), 'shared-model')
    const second = await layout.selectParent(path.join(fixture, 'new-drive'))
    await write(path.join(second.modelsRoot, 'weight'), 'current-model')
    const reopened = make()
    await reopened.initialize()
    const cleaned = await reopened.clear(first.root, noProcesses)
    expect(cleaned.cleanup?.status).toBe('completed')
    expect(cleaned.root).toBe(second.root)
    expect(cleaned.ready).toBe(true)
    expect(await has(first.root)).toBe(false)
    expect(await fs.readFile(path.join(second.modelsRoot, 'weight'), 'utf8')).toBe('current-model')
    expect(await fs.readFile(path.join(fixture, 'shared-huggingface', 'weight'), 'utf8')).toBe('shared-model')
  })

  it('allows only a valid old installation marker to authorize legacy cleanup', async () => {
    await oldMarker()
    await write(path.join(oldRuntime(), 'models', 'weight'))
    await write(path.join(userData, 'archive', 'user-record'), 'keep-archive')
    const layout = make()
    const state = await layout.initialize()
    expect(state.canClear).toBe(true)
    expect((await layout.clear(oldRuntime(), noProcesses)).cleanup?.status).toBe('completed')
    expect(await has(oldRuntime())).toBe(false)
    expect(await fs.readFile(path.join(userData, 'archive', 'user-record'), 'utf8')).toBe('keep-archive')
    expect((await layout.clear(path.join(userData, 'archive'), noProcesses)).cleanup?.status).toBe('failed')
  })

  it('keeps incomplete legacy directories that have no valid installation marker', async () => {
    await write(path.join(oldRuntime(), 'models', 'weight'))
    const layout = make()
    expect((await layout.initialize()).canClear).toBe(false)
    expect((await layout.clear(oldRuntime(), noProcesses)).cleanup?.status).toBe('failed')
    expect(await has(path.join(oldRuntime(), 'models', 'weight'))).toBe(true)
  })

  it('does not adopt or delete a root with a tampered ownership marker', async () => {
    const layout = make()
    const state = await layout.initialize()
    const markerPath = path.join(state.root, '.amadeus-managed-data.json')
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
    marker.owner = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    await fs.writeFile(markerPath, JSON.stringify(marker))
    await write(path.join(state.root, 'keep'))
    const reopened = make()
    expect((await reopened.initialize()).mode).toBe('unavailable')
    expect((await reopened.clear(state.root, noProcesses)).cleanup?.status).toBe('failed')
    expect(await has(path.join(state.root, 'keep'))).toBe(true)
  })

  it('rejects a junction in the selected parent before creating anything behind it', async () => {
    const destination = path.join(fixture, 'shared')
    const junction = path.join(fixture, 'alias')
    await fs.mkdir(destination)
    await fs.symlink(destination, junction, process.platform === 'win32' ? 'junction' : 'dir')
    const layout = make()
    await layout.initialize()
    await expect(layout.selectParent(junction)).rejects.toThrow('链接或重解析')
    expect(await has(path.join(destination, 'AmadeusData'))).toBe(false)
  })

  it('finds a nested cache junction before deleting any owned files', async () => {
    const layout = make()
    const state = await layout.initialize()
    const shared = path.join(fixture, 'shared-cache')
    await write(path.join(shared, 'weight'), 'external-weight')
    await write(path.join(state.root, 'first-file'), 'still-here')
    await fs.symlink(shared, path.join(state.root, 'linked-cache'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await layout.clear(state.root, noProcesses)
    expect(result.cleanup?.status).toBe('failed')
    expect(await fs.readFile(path.join(state.root, 'first-file'), 'utf8')).toBe('still-here')
    expect(await fs.readFile(path.join(shared, 'weight'), 'utf8')).toBe('external-weight')
  })

  it('refuses cleanup when any process still uses the directory', async () => {
    const layout = make()
    const state = await layout.initialize()
    await write(path.join(state.root, 'keep'), 'running-model')
    const result = await layout.clear(state.root, async () => { throw new Error('Process is still using this data') })
    expect(result.cleanup?.status).toBe('failed')
    expect(await fs.readFile(path.join(state.root, 'keep'), 'utf8')).toBe('running-model')
  })

  it('uninstall inspection creates no replacement environment and keeps unknown profile data', async () => {
    const layout = make()
    const state = await layout.initialize({ create: false })
    expect(state.ready).toBe(false)
    expect(await has(state.root)).toBe(false)
    expect(await has(userData)).toBe(false)
  })

  it('does not silently recreate the default location after clearing a custom data root', async () => {
    const layout = make()
    await layout.initialize({ create: false })
    const chosen = await layout.selectParent(path.join(fixture, 'large-drive'))
    expect((await layout.clear(chosen.root, noProcesses)).ready).toBe(false)
    const reopened = make()
    const result = await reopened.initialize()
    expect(result.ready).toBe(false)
    expect(result.root).toBe(chosen.root)
    expect(await has(result.defaultRoot)).toBe(false)
    expect(await has(chosen.root)).toBe(false)
    expect((await reopened.selectParent(path.join(fixture, 'large-drive'))).ready).toBe(true)
  })

  it.each(['managed', 'legacy'] as const)('invalidates a %s runtime after a partial deletion and retains safe retry evidence', async (mode) => {
    if (mode === 'legacy') await oldMarker()
    const layout = make()
    const state = await layout.initialize()
    const installation = path.join(state.runtimeRoot, 'installation.json')
    if (mode === 'managed') await write(installation, JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), installedAt: '2026-10-05T00:00:00.000Z' }))
    await write(path.join(state.root, 'a-first'), 'first')
    const locked = path.join(state.root, 'z-locked')
    await write(locked, 'locked')
    const originalUnlink = fs.unlink.bind(fs)
    const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (String(file) === locked) throw Object.assign(new Error('Fixture file is locked'), { code: 'EPERM' })
      return originalUnlink(file)
    })
    const result = await layout.clear(state.root, noProcesses)
    expect(result.cleanup?.status).toBe('failed')
    expect(result.cleanup?.message).toContain('部分文件可能已删除')
    expect(await has(installation)).toBe(false)
    expect(await has(path.join(state.root, '.amadeus-incomplete-installation.json'))).toBe(true)
    expect(await has(path.join(state.root, 'a-first'))).toBe(false)
    expect(await has(locked)).toBe(true)
    unlink.mockRestore()
    const reopened = make()
    expect((await reopened.initialize()).canClear).toBe(true)
    expect((await reopened.clear(state.root, noProcesses)).cleanup?.status).toBe('completed')
    expect(await has(state.root)).toBe(false)
  })

  // WMI is denied by the Codex process sandbox. Opt in for the read-only Windows
  // integration check; ordinary unit tests remain runnable in a sandbox/CI.
  it.runIf(process.platform === 'win32' && process.env.AMADEUS_TEST_WINDOWS_STORAGE_PREFLIGHT === '1')('runs the Windows reparse/process preflight against an isolated fixture', async () => {
    const layout = make()
    const state = await layout.initialize()
    const result = await layout.clear(state.root)
    expect(result.cleanup?.status).toBe('completed')
    expect(await has(state.root)).toBe(false)
  }, 15_000)
})
