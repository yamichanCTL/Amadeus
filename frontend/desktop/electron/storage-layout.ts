import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Mirrored by src/services/storageTypes.ts: the renderer never receives an owner token.
export interface ManagedStoragePaths {
  root: string; runtimeRoot: string; pythonRoot: string; modelsRoot: string
  cacheRoot: string; tempRoot: string; backendDataRoot: string; avatarRoot: string; archiveRoot: string
}
export interface RetainedStoragePath {
  path: string; label: string; kind: 'managed' | 'legacy-runtime' | 'legacy-data'; canClear: boolean; reason?: string
}
export interface StorageState extends ManagedStoragePaths {
  mode: 'managed' | 'legacy' | 'unavailable'; ready: boolean; configRoot: string; defaultRoot: string
  legacyPaths: RetainedStoragePath[]; canChange: boolean; canClear: boolean; busy?: boolean; error?: string
  message: string; cleanup?: { status: 'completed' | 'failed'; path: string; message: string }
}
interface OwnedRoot { root: string; owner: string }
interface StoragePointer { version: 1; current?: OwnedRoot; retained: OwnedRoot[]; emptyRoot?: string }
interface StorageOptions { userData: string; installDir: string; defaultRoot?: string }
const MARKER = '.amadeus-managed-data.json'
const INCOMPLETE_INSTALLATION = '.amadeus-incomplete-installation.json'
const APP_ID = 'com.asrapp.desktop'
const execFileAsync = promisify(execFile)
const samePath = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
const inside = (parent: string, child: string) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
const exists = async (target: string) => { try { await fs.lstat(target); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }

export function managedStoragePaths(root: string): ManagedStoragePaths {
  root = path.resolve(root)
  return { root, runtimeRoot: path.join(root, 'runtime'), pythonRoot: path.join(root, 'python'), modelsRoot: path.join(root, 'models'),
    cacheRoot: path.join(root, 'cache'), tempRoot: path.join(root, 'tmp'), backendDataRoot: path.join(root, 'backend-data'),
    avatarRoot: path.join(root, 'avatars'), archiveRoot: path.join(root, 'archive') }
}

export function managedRuntimeEnvironment(p: ManagedStoragePaths): Record<string, string> {
  const hf = path.join(p.cacheRoot, 'huggingface')
  const model = (...parts: string[]) => path.join(p.modelsRoot, ...parts)
  return {
    PROJECT_ROOT: p.root, MODELS_DIR: p.modelsRoot,
    UV_PYTHON_INSTALL_DIR: p.pythonRoot, UV_PYTHON_BIN_DIR: path.join(p.pythonRoot, 'bin'), UV_CACHE_DIR: path.join(p.cacheRoot, 'uv'),
    UV_TOOL_DIR: path.join(p.runtimeRoot, 'tools'), UV_TOOL_BIN_DIR: path.join(p.runtimeRoot, 'bin'),
    PIP_CACHE_DIR: path.join(p.cacheRoot, 'pip'), XDG_CACHE_HOME: p.cacheRoot,
    HF_HOME: hf, HF_HUB_CACHE: path.join(hf, 'hub'), HUGGINGFACE_HUB_CACHE: path.join(hf, 'hub'),
    HF_ASSETS_CACHE: path.join(hf, 'assets'), HF_XET_CACHE: path.join(hf, 'xet'), HF_MODULES_CACHE: path.join(hf, 'modules'),
    TRANSFORMERS_CACHE: path.join(hf, 'hub'), MODELSCOPE_CACHE: path.join(p.cacheRoot, 'modelscope'), TORCH_HOME: path.join(p.cacheRoot, 'torch'),
    TEMP: p.tempRoot, TMP: p.tempRoot, TMPDIR: p.tempRoot,
    SENSEVOICE_MODEL_DIR: model('SenseVoiceSmall'), FIREREDASR2_MODEL_DIR: model('fireredasr2', 'FireRedASR2-AED'),
    FIRERED_VAD_MODEL_DIR: model('fireredasr2', 'FireRedVAD', 'Stream-VAD'), QWEN3ASR_MODEL_DIR: model('Qwen3-ASR-1.7B'),
    FORMALASR_MODEL_DIR: model('FormalASR-1.7B'), X_ASR_MODEL_DIR: model('x-asr', 'chunk-960ms-model'),
    DATABASE_URL: `sqlite+aiosqlite:///${path.join(p.backendDataRoot, 'amadeus.db').replace(/\\/g, '/')}`,
    AUDIO_UPLOAD_DIR: path.join(p.backendDataRoot, 'audio'), TRANSCRIPT_DIR: path.join(p.backendDataRoot, 'transcripts'),
    TTS_DATA_DIR: path.join(p.backendDataRoot, 'tts'), ARCHIVE_DIR: p.archiveRoot, CODEX_RUNTIME_DIR: path.join(p.backendDataRoot, 'codex'),
  }
}

/** Refuse symlinks/junctions in every existing ancestor, including the selected parent. */
export async function assertDirectStoragePath(target: string): Promise<void> {
  const absolute = path.resolve(target)
  const chain: string[] = []
  for (let current = absolute; ; current = path.dirname(current)) {
    chain.push(current)
    if (current === path.dirname(current)) break
  }
  for (const current of chain.reverse()) {
    if (!await exists(current)) continue
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink() || !samePath(await fs.realpath(current), current)) throw new Error(`目录包含链接或重解析路径，已拒绝操作：${current}`)
  }
}

// Windows exposes reparse attributes that Node's Stats does not. No path or process
// command line is interpolated into executable code; the subprocess only returns counts.
async function assertWindowsTreeAndProcesses(root: string): Promise<void> {
  if (process.platform !== 'win32') return
  const script = `$ErrorActionPreference='Stop'; $r=$env:AMADEUS_STORAGE_CHECK_ROOT; $prefix=$r.TrimEnd('\\')+'\\'; ` +
    `$stack=New-Object 'System.Collections.Generic.Stack[string]'; $stack.Push($r); while($stack.Count -gt 0){ $p=$stack.Pop(); $i=Get-Item -LiteralPath $p -Force; if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE'}; if($i.PSIsContainer){ Get-ChildItem -LiteralPath $p -Force | ForEach-Object {$stack.Push($_.FullName)} } }; ` +
    `$busy=@(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($prefix,[StringComparison]::OrdinalIgnoreCase) -ge 0) }); if($busy.Count -gt 0){throw 'IN_USE'}; Write-Output 'OK'`
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 120_000, maxBuffer: 4096, env: { ...process.env, AMADEUS_STORAGE_CHECK_ROOT: root },
    })
    if (result.stdout.trim() !== 'OK') throw new Error('Storage check incomplete')
  } catch {
    throw new Error(`无法确认目录可安全清理：可能有正在使用它的进程、链接或重解析点。数据已保留，请关闭服务后重试：${root}`)
  }
}

export class StorageLayout {
  private readonly configRoot: string
  private readonly installDir: string
  private readonly defaultRoot: string
  private readonly pointerPath: string
  private pointer: StoragePointer = { version: 1, retained: [] }
  private state!: StorageState

  constructor(options: StorageOptions) {
    this.configRoot = path.resolve(options.userData)
    this.installDir = path.resolve(options.installDir)
    this.defaultRoot = path.resolve(options.defaultRoot || path.join(path.dirname(this.installDir), 'AmadeusData'))
    this.pointerPath = path.join(this.configRoot, 'storage-pointer.json')
  }

  private validateRoot(root: string): string {
    if (!path.isAbsolute(root)) throw new Error('数据目录必须是绝对路径')
    const resolved = path.resolve(root)
    if (resolved === path.parse(resolved).root || inside(resolved, this.configRoot) || inside(resolved, this.installDir) || inside(this.installDir, resolved) || inside(this.configRoot, resolved)) {
      throw new Error('请选择应用安装目录和 AppData 之外的专用数据目录')
    }
    return resolved
  }

  private async readMarker(owned: OwnedRoot): Promise<void> {
    this.validateRoot(owned.root)
    await assertDirectStoragePath(owned.root)
    const marker = path.join(owned.root, MARKER)
    await assertDirectStoragePath(marker)
    const raw = JSON.parse(await fs.readFile(marker, 'utf8')) as Record<string, unknown>
    if (raw.version !== 1 || raw.appId !== APP_ID || raw.owner !== owned.owner || typeof raw.root !== 'string' || !samePath(raw.root, owned.root)) {
      throw new Error(`数据目录所有权标记不匹配，已保留：${owned.root}`)
    }
  }

  private async savePointer(): Promise<void> {
    await fs.mkdir(this.configRoot, { recursive: true })
    const temporary = `${this.pointerPath}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, JSON.stringify(this.pointer, null, 2), { flag: 'wx' })
    await fs.rename(temporary, this.pointerPath)
  }

  private async createRoot(root: string): Promise<OwnedRoot> {
    root = this.validateRoot(root)
    await assertDirectStoragePath(root)
    const known = [this.pointer.current, ...this.pointer.retained].find(item => item && samePath(item.root, root))
    if (known) { await this.readMarker(known); return known }
    if (await exists(root) && (await fs.readdir(root)).length) throw new Error(`目录不是空目录，不能接管已有文件：${root}`)
    await fs.mkdir(root, { recursive: true })
    await assertDirectStoragePath(root)
    const probe = path.join(root, `.write-check-${randomUUID()}`)
    await fs.writeFile(probe, 'Amadeus write check', { flag: 'wx' })
    await fs.unlink(probe)
    const owned = { root, owner: randomUUID() }
    await fs.writeFile(path.join(root, MARKER), JSON.stringify({ version: 1, appId: APP_ID, ...owned }, null, 2), { flag: 'wx' })
    // New ownership is saved before runtime installation; a failed install stays identifiable.
    return owned
  }

  private legacyRuntime(): string { return path.join(this.configRoot, 'local-runtime') }

  private async legacyIsPlaceholder(): Promise<boolean> {
    const root = this.legacyRuntime()
    const entries = await fs.readdir(root, { withFileTypes: true })
    // Version 0.1.6 created logs/ simply by opening the app. Such a shell is not
    // an installed environment and must not pin a first installation to AppData.
    // Inspect metadata only; retain every old file in place.
    const directLogTree = async (directory: string): Promise<boolean> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        const stat = await fs.lstat(target)
        if (stat.isSymbolicLink() || !samePath(await fs.realpath(target), target)) return false
        if (stat.isDirectory()) { if (!await directLogTree(target)) return false }
        else if (!stat.isFile()) return false
      }
      return true
    }
    for (const entry of entries) {
      const target = path.join(root, entry.name)
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink() || !samePath(await fs.realpath(target), target)) return false
      if (entry.name === 'preferences.json' && stat.isFile()) continue
      if (entry.name === 'logs' && stat.isDirectory() && await directLogTree(target)) continue
      return false
    }
    return true
  }

  private async assertLegacyRuntime(root: string): Promise<void> {
    if (!samePath(root, this.legacyRuntime())) throw new Error('不是此配置的旧受管运行环境')
    await assertDirectStoragePath(root)
    const activeMarker = path.join(root, 'installation.json')
    const marker = await exists(activeMarker) ? activeMarker : path.join(root, INCOMPLETE_INSTALLATION)
    await assertDirectStoragePath(marker)
    const parsed = JSON.parse(await fs.readFile(marker, 'utf8')) as Record<string, unknown>
    if (parsed.version !== 1 || typeof parsed.fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.fingerprint) || typeof parsed.installedAt !== 'string' || !Number.isFinite(Date.parse(parsed.installedAt))) {
      throw new Error('旧环境没有有效安装标记，禁止自动清理')
    }
  }

  private async retainedPaths(currentRoot: string): Promise<RetainedStoragePath[]> {
    const result: RetainedStoragePath[] = []
    for (const owned of this.pointer.retained) {
      if (samePath(owned.root, currentRoot) || !await exists(owned.root)) continue
      let reason: string | undefined
      try { await this.readMarker(owned) } catch (error) { reason = (error as Error).message }
      result.push({ path: owned.root, label: '保留的受管数据', kind: 'managed', canClear: !reason, reason })
    }
    if (!samePath(currentRoot, this.legacyRuntime()) && await exists(this.legacyRuntime())) {
      let reason: string | undefined
      try { await this.assertLegacyRuntime(this.legacyRuntime()) } catch { reason = '缺少有效安装标记，仅可打开，不能自动清理' }
      result.push({ path: this.legacyRuntime(), label: '旧版本机环境和模型', kind: 'legacy-runtime', canClear: !reason, reason })
    }
    for (const name of ['avatars', 'archive']) {
      const old = path.join(this.configRoot, name)
      if (await exists(old)) result.push({ path: old, label: name === 'avatars' ? '旧版角色副本' : '旧版归档', kind: 'legacy-data', canClear: false, reason: '原有数据保留，可打开后自行整理；不会自动删除' })
    }
    return result
  }

  private async updateState(mode: StorageState['mode'], root: string, error?: string): Promise<StorageState> {
    const p = managedStoragePaths(root)
    if (mode === 'legacy') Object.assign(p, { runtimeRoot: root, pythonRoot: path.join(root, 'python'), modelsRoot: path.join(root, 'models'), cacheRoot: path.join(root, 'cache'), tempRoot: path.join(root, 'tmp'), backendDataRoot: root, avatarRoot: path.join(this.configRoot, 'avatars'), archiveRoot: path.join(this.configRoot, 'archive') })
    let canClear = mode === 'managed'
    if (mode === 'legacy') { try { await this.assertLegacyRuntime(root); canClear = true } catch { /* incomplete/unknown old directories remain protected */ } }
    this.state = { ...p, mode, ready: mode !== 'unavailable', configRoot: this.configRoot, defaultRoot: this.defaultRoot,
      legacyPaths: await this.retainedPaths(root), canChange: true, canClear, error,
      message: mode === 'legacy' ? '正在沿用旧目录。选择新位置后需安装环境；原环境和模型不会自动移动，可单独确认清理。' : mode === 'managed' ? 'Python、依赖、模型、下载缓存和临时文件统一保存在此目录。少量界面配置、浏览器缓存和目录指针仍在 AppData。' : '数据目录不可用，请选择可写位置；不会自动改用 C 盘。' }
    return this.snapshot()
  }

  snapshot(): StorageState { return { ...this.state, legacyPaths: this.state.legacyPaths.map(item => ({ ...item })) } }
  paths(): ManagedStoragePaths | undefined { return this.state.mode === 'managed' && this.state.ready ? managedStoragePaths(this.state.root) : undefined }

  async initialize(options: { create?: boolean } = {}): Promise<StorageState> {
    try {
      if (await exists(this.pointerPath)) {
        await assertDirectStoragePath(this.pointerPath)
        const parsed = JSON.parse(await fs.readFile(this.pointerPath, 'utf8')) as StoragePointer
        if (parsed.version !== 1 || !Array.isArray(parsed.retained) || [...parsed.retained, ...(parsed.current ? [parsed.current] : [])].some(item => !item || typeof item.root !== 'string' || typeof item.owner !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.owner))) throw new Error('数据目录配置损坏，请保留原目录并重新选择位置')
        this.pointer = parsed
      }
      if (this.pointer.current) {
        await this.readMarker(this.pointer.current)
        return this.updateState('managed', this.pointer.current.root)
      }
      if (this.pointer.emptyRoot) return this.updateState('unavailable', this.validateRoot(this.pointer.emptyRoot))
      if (await exists(this.legacyRuntime())) {
        await assertDirectStoragePath(this.legacyRuntime())
        if (!await this.legacyIsPlaceholder()) return this.updateState('legacy', this.legacyRuntime())
      }
      if (options.create === false) return this.updateState('unavailable', this.defaultRoot)
      this.pointer.current = await this.createRoot(this.defaultRoot)
      await this.savePointer()
      return this.updateState('managed', this.defaultRoot)
    } catch (error) {
      return this.updateState('unavailable', this.pointer.current?.root || this.defaultRoot, (error as Error).message)
    }
  }

  /** Select creates a clean environment, never renames a venv or removes prior data. */
  async selectParent(parent: string): Promise<StorageState> {
    if (!path.isAbsolute(parent)) throw new Error('请选择绝对目录')
    const root = path.join(parent, 'AmadeusData')
    const next = await this.createRoot(root)
    const previous = this.pointer.current
    if (previous && !samePath(previous.root, next.root) && !this.pointer.retained.some(item => samePath(item.root, previous.root))) this.pointer.retained.push(previous)
    this.pointer.current = next
    this.pointer.emptyRoot = undefined
    this.pointer.retained = this.pointer.retained.filter(item => !samePath(item.root, next.root))
    await this.savePointer()
    return this.updateState('managed', next.root)
  }

  allowedPath(target?: string): string {
    const selected = target || this.state.root
    if (samePath(selected, this.state.root)) return this.state.root
    const retained = this.state.legacyPaths.find(item => samePath(item.path, selected))
    if (retained) return retained.path
    throw new Error('只允许操作本应用列出的数据目录')
  }

  async clear(target: string, beforeDelete: (root: string) => Promise<void> = assertWindowsTreeAndProcesses): Promise<StorageState> {
    const root = this.allowedPath(target)
    let deletionStarted = false
    try {
      const legacy = samePath(root, this.legacyRuntime())
      const owned = [this.pointer.current, ...this.pointer.retained].find(item => item && samePath(item.root, root))
      if (legacy) await this.assertLegacyRuntime(root)
      else if (owned) await this.readMarker(owned)
      else throw new Error('此目录不具备受管所有权，禁止自动删除')
      await beforeDelete(root)
      // Inspect the entire tree before the first unlink. Shared caches reached via
      // junctions are never followed or partly cleared.
      const files: string[] = []; const directories: string[] = []
      const scan = async (directory: string) => {
        await assertDirectStoragePath(directory)
        directories.push(directory)
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const child = path.join(directory, entry.name)
          if (!inside(root, child)) throw new Error('清理目标超出受管目录')
          const stat = await fs.lstat(child)
          if (stat.isSymbolicLink() || !samePath(await fs.realpath(child), child)) throw new Error(`目录中存在链接，数据已保留：${child}`)
          if (stat.isDirectory()) await scan(child)
          else if (stat.isFile()) files.push(child)
          else throw new Error('目录含有非普通文件，已停止清理')
        }
      }
      await scan(root)
      if (legacy) await this.assertLegacyRuntime(root); else await this.readMarker(owned!)
      const installationMarker = path.join(root, ...(legacy ? [] : ['runtime']), 'installation.json')
      const incompleteMarker = path.join(root, INCOMPLETE_INSTALLATION)
      // Invalidate the runtime before the first deletion. A locked file later in
      // the tree must never leave installed=true for a partly deleted venv.
      if (await exists(installationMarker)) {
        await assertDirectStoragePath(installationMarker)
        if (await exists(incompleteMarker)) await assertDirectStoragePath(incompleteMarker)
        await fs.rename(installationMarker, incompleteMarker)
      }
      deletionStarted = true
      const ownershipMarker = path.join(root, legacy ? INCOMPLETE_INSTALLATION : MARKER)
      // Ownership/retry evidence is the last thing removed, after every child dir.
      for (const file of files.filter(file => !samePath(file, ownershipMarker) && !samePath(file, installationMarker) && !samePath(file, incompleteMarker))) {
        await assertDirectStoragePath(file)
        await fs.unlink(file)
      }
      for (const directory of directories.reverse().filter(directory => !samePath(directory, root))) {
        await assertDirectStoragePath(directory)
        await fs.rmdir(directory)
      }
      await assertDirectStoragePath(root)
      if (!samePath(incompleteMarker, ownershipMarker) && await exists(incompleteMarker)) await fs.unlink(incompleteMarker)
      await fs.unlink(ownershipMarker)
      await fs.rmdir(root)
      if (this.pointer.current && samePath(root, this.pointer.current.root)) {
        this.pointer.current = undefined
        this.pointer.emptyRoot = root
      }
      this.pointer.retained = this.pointer.retained.filter(item => !samePath(root, item.root))
      await this.savePointer()
      const currentDeleted = samePath(root, this.state.root)
      await this.updateState(currentDeleted ? 'unavailable' : this.state.mode, this.state.root)
      this.state.cleanup = { status: 'completed', path: root, message: '已清理所选受管目录。其它目录和外部共享缓存未改动。' }
    } catch (error) {
      const message = deletionStarted ? `清理中途停止，部分文件可能已删除；本机环境需要重新安装。可修复环境或重试清理：${root}\n${(error as Error).message}` : (error as Error).message
      this.state.cleanup = { status: 'failed', path: root, message }
      this.state.error = message
    }
    return this.snapshot()
  }
}
