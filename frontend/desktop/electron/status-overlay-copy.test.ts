import { describe, expect, it, vi } from 'vitest'
import { copyOverlayResultNonBlocking } from './status-overlay-copy'

describe('status overlay copy', () => {
  it('closes immediately before touching a potentially slow native clipboard', () => {
    const queued: Array<() => void> = []
    const writeText = vi.fn()
    const notify = vi.fn()

    expect(copyOverlayResultNonBlocking('ASR 结果', writeText, notify, (callback) => queued.push(callback))).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('ASR 结果')

    queued[0]()
    expect(writeText).toHaveBeenCalledWith('ASR 结果')
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
