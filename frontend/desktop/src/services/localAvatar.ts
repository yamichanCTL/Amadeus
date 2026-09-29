import type { LocalAvatarStatus } from '../vite-env'

export interface LocalAvatarReader {
  localAvatarStatus(): Promise<LocalAvatarStatus>
  localAvatarRead(): Promise<ArrayBuffer | null>
  onLocalAvatarChanged(callback: (status: LocalAvatarStatus) => void): () => void
}

/** Subscribe before reading status so an old initial reply cannot replace a new import. */
export function watchLocalAvatar(api: LocalAvatarReader, receive: (status: LocalAvatarStatus) => void): () => void {
  let disposed = false
  let changed = false
  const unsubscribe = api.onLocalAvatarChanged(status => {
    changed = true
    if (!disposed) receive(status)
  })
  void api.localAvatarStatus().then(status => {
    if (!disposed && !changed) receive(status)
  }, error => {
    if (!disposed && !changed) receive({ available: false, name: null, size: 0, revision: null,
      error: error instanceof Error ? error.message : '读取本地模型状态失败。' })
  })
  return () => { disposed = true; unsubscribe() }
}
