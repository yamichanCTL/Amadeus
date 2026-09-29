import { describe, expect, it, vi } from 'vitest'
import { watchLocalAvatar, type LocalAvatarReader } from './localAvatar'
import type { LocalAvatarStatus } from '../vite-env'

const empty: LocalAvatarStatus = { available: false, name: null, size: 0, revision: null }
const imported: LocalAvatarStatus = { available: true, name: 'model.glb', size: 1024, revision: 'new' }

describe('local avatar status lifecycle', () => {
  it('does not let a delayed initial status replace a newly imported model', async () => {
    let resolve!: (status: LocalAvatarStatus) => void
    let update!: (status: LocalAvatarStatus) => void
    const api: LocalAvatarReader = {
      localAvatarStatus: () => new Promise(done => { resolve = done }), localAvatarRead: vi.fn(),
      onLocalAvatarChanged: callback => { update = callback; return vi.fn() },
    }
    const receive = vi.fn()
    const stop = watchLocalAvatar(api, receive)
    update(imported)
    resolve(empty)
    await Promise.resolve()
    expect(receive.mock.calls).toEqual([[imported]])
    stop()
  })

  it('unsubscribes and ignores pending status after unmount', async () => {
    let resolve!: (status: LocalAvatarStatus) => void
    const unsubscribe = vi.fn()
    const receive = vi.fn()
    const api = { localAvatarStatus: () => new Promise<LocalAvatarStatus>(done => { resolve = done }),
      localAvatarRead: vi.fn(), onLocalAvatarChanged: () => unsubscribe }
    watchLocalAvatar(api, receive)()
    resolve(imported)
    await Promise.resolve()
    expect(receive).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
