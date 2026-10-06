// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { runTextInjectionWithRecovery, TextInjectionCancelledError, TextInjectionNotSentError } from './text-inject-retry'

describe('text injection helper recovery', () => {
  it('restarts once after a transient post-reboot helper failure', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new TextInjectionNotSentError('helper was not ready before delivery'))
      .mockResolvedValueOnce(true)
    const reset = vi.fn()

    await expect(runTextInjectionWithRecovery(attempt, reset)).resolves.toBe(true)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the focused control is intentionally non-editable', async () => {
    const attempt = vi.fn(async () => false)
    const reset = vi.fn()

    await expect(runTextInjectionWithRecovery(attempt, reset)).resolves.toBe(false)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
  })

  it('does not revive a stale injection cancelled by a newer ASR result', async () => {
    const attempt = vi.fn().mockRejectedValue(new TextInjectionCancelledError())
    const reset = vi.fn()

    await expect(runTextInjectionWithRecovery(attempt, reset)).rejects.toBeInstanceOf(TextInjectionCancelledError)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
  })

  it('does not paste a second time when the helper reply timed out after submission', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('delivery acknowledgement timed out'))
    const reset = vi.fn()
    await expect(runTextInjectionWithRecovery(attempt, reset)).rejects.toThrow('timed out')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
  })
})
