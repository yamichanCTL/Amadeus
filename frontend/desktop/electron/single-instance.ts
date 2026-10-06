import path from 'node:path'

type InstanceApp = {
  getPath(name: 'appData' | 'userData'): string
  setPath(name: 'userData', value: string): void
  requestSingleInstanceLock(): boolean
}

/** One Amadeus per OS user, including development and isolated preview profiles. */
export function acquireAppInstanceLock(app: InstanceApp): boolean {
  const profilePath = app.getPath('userData')
  const lockPath = path.join(app.getPath('appData'), 'Amadeus')
  try {
    // Electron captures this path when it constructs its native ProcessSingleton.
    // Keep the lock identity independent of the EXE location and selected profile.
    app.setPath('userData', lockPath)
    return app.requestSingleInstanceLock()
  } finally {
    // The native lock stays held until exit; caches and settings use the real profile.
    app.setPath('userData', profilePath)
  }
}
