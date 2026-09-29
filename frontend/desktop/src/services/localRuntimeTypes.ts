export type LocalRuntimePhase = 'missing' | 'installing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error'

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
  /** Only a service started by this application can be stopped from the UI. */
  owned: boolean
}
