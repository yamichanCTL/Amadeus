export type LocalRuntimePhase = 'missing' | 'installing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error'

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
  /** Network counters are absent when the installer does not expose them. */
  downloadedBytes?: number
  bytesPerSecond?: number
}

export interface RuntimeInstallProgress {
  stage: RuntimeInstallStage
  /** Milliseconds since the Unix epoch. updatedAt is a heartbeat, not a download event. */
  startedAt: number
  updatedAt: number
  lastEventAt: number
  items: RuntimeInstallItem[]
  observedItems: number
  completedItems: number
  resolvedPackages?: number
  preparedPackages?: number
  installedPackages?: number
  /** Current file sizes, including prior cache and extracted Python. Never network traffic. */
  cache?: {
    bytes: number
    files: number
    scope: 'uv-cache-and-python'
    sampledAt: number
    /** Scan was bounded or some files were inaccessible; values are a lower bound. */
    partial: boolean
  }
}

export interface LocalRuntimeState {
  phase: LocalRuntimePhase
  installed: boolean
  url: string | null
  message: string
  error?: string
  autoStart: boolean
  root: string
  logPath: string
  progress?: number
  installProgress?: RuntimeInstallProgress
  /** Only a service started by this application can be stopped from the UI. */
  owned: boolean
}
