import { promises as fs } from 'node:fs'
import path from 'node:path'

// Keep this IPC data contract in sync with src/services/localRuntimeTypes.ts.
export type RuntimeInstallStage = 'preparing' | 'python' | 'resolving' | 'downloading' | 'extracting' | 'building' | 'installing' | 'verifying' | 'complete' | 'failed' | 'cancelled'
export type RuntimeInstallItemStatus = 'downloading' | 'downloaded' | 'extracting' | 'building' | 'prepared' | 'installed' | 'failed' | 'cancelled'
export interface RuntimeInstallItem {
  id: string
  name: string
  version?: string
  kind: 'python' | 'package'
  status: RuntimeInstallItemStatus
  totalBytes?: number
  totalBytesApproximate?: boolean
  sizeSource?: 'uv-log' | 'lockfile'
  downloadedBytes?: number
  bytesPerSecond?: number
}
export interface RuntimeInstallProgress {
  stage: RuntimeInstallStage
  startedAt: number
  updatedAt: number
  lastEventAt: number
  items: RuntimeInstallItem[]
  observedItems: number
  completedItems: number
  resolvedPackages?: number
  preparedPackages?: number
  installedPackages?: number
  cache?: { bytes: number; files: number; scope: 'uv-cache-and-python'; sampledAt: number; partial: boolean }
}

const completeStatuses = new Set<RuntimeInstallItemStatus>(['downloaded', 'prepared', 'installed'])
const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

/** Read only unambiguous package versions; the universal lock is NOT a download manifest. */
function lockedVersions(lockText: string): Map<string, string | undefined> {
  const versions = new Map<string, Set<string>>()
  for (const block of lockText.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([a-zA-Z0-9_.-]+)"\s*$/m.exec(block)?.[1]
    const version = /^version\s*=\s*"([a-zA-Z0-9_.+!-]+)"\s*$/m.exec(block)?.[1]
    if (!name || !version) continue
    const key = normalize(name)
    const values = versions.get(key) ?? new Set<string>()
    values.add(version)
    versions.set(key, values)
  }
  return new Map([...versions].map(([name, values]) => [name, values.size === 1 ? [...values][0] : undefined]))
}

/** uv's one-decimal log sizes are rounded, never exact content-length counters. */
function logBytes(value: string, unit: string): number | undefined {
  const powers: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, kB: 1000, MB: 1000 ** 2, GB: 1000 ** 3 }
  const bytes = Number(value) * powers[unit]
  return Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : undefined
}

/** Snapshot regular files only, without following symlinks/junctions or reading file contents. */
export async function sampleRuntimeCache(roots: string[], cancelled: () => boolean = () => false, maxEntries = 25_000, maxMillis = 1_500): Promise<NonNullable<RuntimeInstallProgress['cache']> | undefined> {
  const started = Date.now()
  let bytes = 0
  let files = 0
  let entries = 0
  let partial = false
  const pending = [...new Set(roots.map(root => path.resolve(root)))]
  while (pending.length) {
    if (cancelled()) return undefined
    if (entries >= maxEntries || Date.now() - started >= maxMillis) { partial = true; break }
    const directory = pending.pop()!
    try {
      const rootStat = await fs.lstat(directory)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue
      const handle = await fs.opendir(directory)
      for await (const entry of handle) {
        if (cancelled()) return undefined
        if (++entries > maxEntries || Date.now() - started >= maxMillis) { partial = true; break }
        const file = path.join(directory, entry.name)
        // lstat checks again after enumeration, preventing traversal of newly replaced links.
        try {
          const stat = await fs.lstat(file)
          if (stat.isSymbolicLink()) continue
          if (stat.isDirectory()) pending.push(file)
          else if (stat.isFile()) { bytes += stat.size; files++ }
        } catch { partial = true } // Download temp files may disappear during a scan.
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') partial = true
    }
  }
  return { bytes, files, scope: 'uv-cache-and-python', sampledAt: Date.now(), partial }
}

export const runtimeInstallMessages: Record<RuntimeInstallStage, string> = {
  preparing: '正在准备独立的 Python 环境……', python: '正在准备 Python 解释器……',
  resolving: '正在核对锁定的依赖……', downloading: '正在下载运行组件……',
  extracting: '正在解压 Python 解释器……', building: '正在构建运行组件……',
  installing: '正在安装运行组件……', verifying: '正在检查模型运行组件能否加载……',
  complete: '环境安装完成。点击启动即可使用。', failed: '环境安装未完成。', cancelled: '环境安装已取消。',
}

/** uv 0.10.x pipe output reports events and rounded sizes, not live network byte counters. */
export class RuntimeInstallObserver {
  private readonly versions: Map<string, string | undefined>
  private readonly items = new Map<string, RuntimeInstallItem>()
  private progress: RuntimeInstallProgress
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private scanning = false
  private lastScanAt = 0

  constructor(lockText: string, private readonly roots: string[], private readonly onChange: (progress: RuntimeInstallProgress) => void) {
    this.versions = lockedVersions(lockText)
    const now = Date.now()
    this.progress = { stage: 'preparing', startedAt: now, updatedAt: now, lastEventAt: now, items: [], observedItems: 0, completedItems: 0 }
  }

  snapshot(): RuntimeInstallProgress {
    return { ...this.progress, items: [...this.items.values()].map(item => ({ ...item })), cache: this.progress.cache ? { ...this.progress.cache } : undefined }
  }

  start(): void {
    if (this.timer || this.closed) return
    this.emit()
    this.timer = setInterval(() => { this.emit(); void this.sample() }, 1_000)
    this.timer.unref?.()
    void this.sample()
  }

  private emit(): void {
    if (this.closed) return
    this.progress.updatedAt = Date.now()
    this.progress.observedItems = this.items.size
    this.progress.completedItems = [...this.items.values()].filter(item => completeStatuses.has(item.status)).length
    this.onChange(this.snapshot())
  }

  private async sample(): Promise<void> {
    if (this.closed || this.scanning || Date.now() - this.lastScanAt < 2_000) return
    this.scanning = true
    try {
      const sample = await sampleRuntimeCache(this.roots, () => this.closed)
      if (sample && !this.closed) { this.progress.cache = sample; this.lastScanAt = Date.now(); this.emit() }
    } finally { this.scanning = false }
  }

  setStage(stage: RuntimeInstallStage): void {
    if (this.closed) return
    this.progress.stage = stage
    this.progress.lastEventAt = Date.now()
    this.emit()
  }

  consume(raw: string): void {
    if (this.closed) return
    const line = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim()
    const transfer = /^(Downloading|Downloaded|Extracting|Extracted)\s+([a-zA-Z0-9_.+-]+)(?:\s+\((?:download|extract)\))?(?:\s+\(([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB)\))?\s*$/i.exec(line)
    if (transfer) {
      const [, action, rawName, size, unit] = transfer
      const python = /^(?:cpython|pypy)-(\d+\.\d+(?:\.\d+)?)(?:-|$)/.exec(rawName)
      const id = python ? rawName : normalize(rawName)
      const item: RuntimeInstallItem = this.items.get(id) ?? { id, name: python ? 'Python' : id, version: python?.[1] ?? this.versions.get(id), kind: python ? 'python' : 'package', status: 'downloading' }
      const status: Record<string, RuntimeInstallItemStatus> = { downloading: 'downloading', downloaded: 'downloaded', extracting: 'extracting', extracted: 'prepared' }
      item.status = status[action.toLowerCase()]
      // Extraction byte sizes describe the unpacked archive, not its download.
      if (size && /^download/i.test(action)) { item.totalBytes = logBytes(size, unit); item.totalBytesApproximate = true; item.sizeSource = 'uv-log' }
      this.items.set(id, item)
      this.progress.stage = /^extract/i.test(action) ? 'extracting' : python ? 'python' : 'downloading'
    } else {
      const installed = /^\+\s+([a-zA-Z0-9_.-]+)==([a-zA-Z0-9_.+!-]+)/.exec(line)
      const building = /^(Building|Built)\s+([a-zA-Z0-9_.-]+)(?:==([a-zA-Z0-9_.+!-]+))?/.exec(line)
      const summary = /^(Resolved|Prepared|Installed|Audited)\s+(\d+)\s+packages?\b/.exec(line)
      if (installed || building) {
        const name = normalize(installed?.[1] ?? building![2])
        const item = this.items.get(name) ?? { id: name, name, kind: 'package' as const, version: this.versions.get(name), status: 'installed' as const }
        item.version = installed?.[2] ?? building?.[3] ?? item.version
        item.status = installed ? 'installed' : building![1] === 'Built' ? 'prepared' : 'building'
        this.items.set(name, item)
        this.progress.stage = installed ? 'installing' : 'building'
      } else if (summary) {
        const count = Number(summary[2])
        if (summary[1] === 'Resolved') { this.progress.resolvedPackages = count; this.progress.stage = 'resolving' }
        else if (summary[1] === 'Prepared') { this.progress.preparedPackages = count; this.progress.stage = 'installing' }
        else if (summary[1] === 'Installed') { this.progress.installedPackages = count; this.progress.stage = 'installing' }
        else this.progress.stage = 'verifying'
      } else if (/^Using (?:CPython|Python)/.test(line)) {
        const version = /^Using (?:CPython|Python)\s+(\d+\.\d+(?:\.\d+)?)/.exec(line)?.[1]
        if (version && ![...this.items.values()].some(item => item.kind === 'python' && item.version === version)) {
          const id = `python-${version}`
          this.items.set(id, { id, name: 'Python', version, kind: 'python', status: 'prepared' })
        }
        this.progress.stage = 'resolving'
      } else if (/^Creating virtual environment/.test(line)) {
        this.progress.stage = 'resolving'
      } else return
    }
    this.progress.lastEventAt = Date.now()
    this.emit()
  }

  stop(stage: 'complete' | 'failed' | 'cancelled'): void {
    if (this.closed) return
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (stage !== 'complete') {
      for (const item of this.items.values()) if (!completeStatuses.has(item.status)) item.status = stage
    }
    this.progress.stage = stage
    this.progress.lastEventAt = Date.now()
    this.emit()
    this.closed = true
  }
}
