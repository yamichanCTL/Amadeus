export type DownloadRegion = 'mainland' | 'global'
export type DownloadSource = 'auto' | 'huggingface' | 'modelscope' | 'hf-mirror' | 'github'
export interface ModelDownloadFile {
  path: string
  size: number
  downloaded_bytes: number
  status: 'pending' | 'downloading' | 'verifying' | 'completed'
}
export interface ModelDownloadJob {
  id: string
  status: 'queued' | 'downloading' | 'verifying' | 'completed' | 'cancelled' | 'error'
  downloaded_bytes: number
  total_bytes: number
  speed_bytes_per_second: number
  current_file: string
  current_file_downloaded_bytes?: number
  current_file_total_bytes?: number
  transferred_bytes?: number
  total_files?: number
  completed_files?: number
  files?: ModelDownloadFile[]
  message?: string
  target_path?: string
  staging_path?: string | null
  backup_path?: string | null
  error?: string
  source?: string
  region?: DownloadRegion
}
export interface DownloadableModel {
  id: string
  engine: string
  model_name: string
  label: string
  estimated_size_bytes?: number
  notes?: string | string[]
  runtime_extra?: string
  sources: Array<{ id: Exclude<DownloadSource, 'auto'>; repo?: string; label?: string; url?: string }>
  weights: { status: 'missing' | 'existing' | 'ready'; verified: boolean; path: string }
  runtime: { installed: boolean; extra: string; missing_modules: string[]; notes?: string }
  job?: ModelDownloadJob
}
export interface ModelDownloadCatalog { models: DownloadableModel[]; jobs: ModelDownloadJob[] }

export function suggestedDownloadRegion(): DownloadRegion {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return ['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Urumqi'].includes(zone) ? 'mainland' : 'global'
}

export function formatDownloadBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`
}
