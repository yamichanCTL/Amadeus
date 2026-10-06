import { describe, expect, it, vi } from 'vitest'
import { WarmOverlay, type WarmOverlaySurface } from './warm-overlay'

function surface(): WarmOverlaySurface<string> {
  return { isDestroyed: vi.fn(() => false), apply: vi.fn(), showInactive: vi.fn(), hide: vi.fn() }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('prewarmed status overlay lifecycle', () => {
  it('loads while hidden and reuses the prepared surface for the first trigger', async () => {
    const view = surface()
    const create = vi.fn(async () => view)
    const overlay = new WarmOverlay(create)
    await overlay.prepare()
    expect(view.showInactive).not.toHaveBeenCalled()
    expect(view.apply).not.toHaveBeenCalled()
    await overlay.show('recording')
    expect(create).toHaveBeenCalledOnce()
    expect(view.apply).toHaveBeenCalledWith('recording')
    expect(view.showInactive).toHaveBeenCalledOnce()
  })

  it('never revives a cancelled cold-start overlay', async () => {
    const opening = deferred<WarmOverlaySurface<string>>()
    const view = surface()
    const overlay = new WarmOverlay(() => opening.promise)
    const showing = overlay.show('recording')
    overlay.hide()
    opening.resolve(view)
    expect(await showing).toBe(false)
    expect(view.showInactive).not.toHaveBeenCalled()
    expect(view.apply).not.toHaveBeenCalled()
  })

  it('only renders the newest phase when creation is pending', async () => {
    const opening = deferred<WarmOverlaySurface<string>>()
    const view = surface()
    const create = vi.fn(() => opening.promise)
    const overlay = new WarmOverlay(create)
    const old = overlay.show('recording')
    const latest = overlay.show('thinking')
    opening.resolve(view)
    expect(await old).toBe(false)
    expect(await latest).toBe(true)
    expect(create).toHaveBeenCalledOnce()
    expect(view.apply).toHaveBeenCalledExactlyOnceWith('thinking')
  })

  it('recovers from a failed warm-up on the next request', async () => {
    const view = surface()
    const create = vi.fn().mockRejectedValueOnce(new Error('load failed')).mockResolvedValue(view)
    const overlay = new WarmOverlay<string>(create)
    await expect(overlay.prepare()).rejects.toThrow('load failed')
    expect(await overlay.show('recording')).toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('recreates a destroyed surface instead of showing it', async () => {
    const first = surface()
    const second = surface()
    const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const overlay = new WarmOverlay<string>(create)
    await overlay.prepare()
    vi.mocked(first.isDestroyed).mockReturnValue(true)
    expect(await overlay.show('recording')).toBe(true)
    expect(first.showInactive).not.toHaveBeenCalled()
    expect(second.showInactive).toHaveBeenCalledOnce()
  })
})
