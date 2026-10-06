/** Paths contain no credentials; large data lives outside the application install. */
export interface ManagedStoragePaths {
  root: string
  runtimeRoot: string
  pythonRoot: string
  modelsRoot: string
  cacheRoot: string
  tempRoot: string
  backendDataRoot: string
  avatarRoot: string
  archiveRoot: string
}

export interface RetainedStoragePath {
  path: string
  label: string
  kind: 'managed' | 'legacy-runtime' | 'legacy-data'
  canClear: boolean
  reason?: string
}

export interface StorageState extends ManagedStoragePaths {
  mode: 'managed' | 'legacy' | 'unavailable'
  ready: boolean
  configRoot: string
  defaultRoot: string
  legacyPaths: RetainedStoragePath[]
  canChange: boolean
  canClear: boolean
  busy?: boolean
  error?: string
  message: string
  cleanup?: { status: 'completed' | 'failed'; path: string; message: string }
}
