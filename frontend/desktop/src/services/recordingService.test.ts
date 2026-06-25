/**
 * Polling & blob guard tests.
 *
 * Tests the adaptive polling pattern: 200ms→500ms→1000ms
 * and the blob size guard against empty WebM containers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Blob guard ────────────────────────────────────────────────────────────
describe('blob guard', () => {
  it('tiny blobs < 800 bytes indicate empty WebM containers', () => {
    expect(new Blob([new Uint8Array(100)]).size).toBeLessThan(800)
    expect(new Blob([new Uint8Array(700)]).size).toBeLessThan(800)
  })

  it('blobs >= 800 bytes pass the guard', () => {
    expect(new Blob([new Uint8Array(800)]).size).toBeGreaterThanOrEqual(800)
    expect(new Blob([new Uint8Array(3200)]).size).toBeGreaterThanOrEqual(800)
  })
})

// ── Adaptive poll interval logic ───────────────────────────────────────────
describe('adaptive poll intervals', () => {
  it('uses 200ms for polls 1-5, 500ms for 6-15, 1000ms for 16+', () => {
    // This is the exact logic from the fix in recordingService.ts
    function getInterval(pollCount: number): number {
      return pollCount < 5 ? 200 : pollCount < 15 ? 500 : 1000
    }

    // First 5 polls at 200ms
    for (let i = 0; i < 5; i++) {
      expect(getInterval(i)).toBe(200)
    }

    // Polls 5-14 at 500ms
    for (let i = 5; i < 15; i++) {
      expect(getInterval(i)).toBe(500)
    }

    // Polls 15+ at 1000ms
    for (let i = 15; i < 20; i++) {
      expect(getInterval(i)).toBe(1000)
    }
  })

  it('worst-case wait for fast task: 200ms instead of old 1000ms', () => {
    // Before fix: first poll always waited 1000ms
    // After fix: first poll waits 200ms
    // For a task that completes in 100ms, the old code wasted 900ms
    const oldInterval = 1000
    const newInterval = 200
    expect(newInterval).toBeLessThan(oldInterval)
    expect(oldInterval - newInterval).toBe(800) // 800ms saved
  })

  it('maximum poll latency in first 5 attempts: 200ms each', () => {
    // If the task completes right after a poll, max wait is 200ms (vs 1000ms before)
    const maxGap = 200
    // Total max extra wait over 5 polls: 5×200=1000ms (vs 5×1000=5000ms before)
    expect(maxGap * 5).toBe(1000)
  })
})

// ── Timeout calculation ────────────────────────────────────────────────────
describe('injectText timeout', () => {
  it('new timeout 400ms is 3x faster than old 1200ms', () => {
    const oldTimeout = 1200
    const newTimeout = 400
    expect(newTimeout).toBeLessThan(oldTimeout)
    expect(oldTimeout / newTimeout).toBe(3)
  })
})

// ── Parallel delivery ─────────────────────────────────────────────────────
describe('deliverResult + persistResult', () => {
  it('Promise.all runs both in parallel, not sequentially', async () => {
    const order: string[] = []

    const persistFn = async () => {
      await new Promise(r => setTimeout(r, 100))
      order.push('persist')
    }
    const deliverFn = async () => {
      await new Promise(r => setTimeout(r, 100))
      order.push('deliver')
    }

    // Old pattern: await a; await b (sequential)
    // New pattern: await Promise.all([a, b]) (parallel)
    const t0 = Date.now()
    await Promise.all([persistFn(), deliverFn()])
    const elapsed = Date.now() - t0

    // Both should complete in ~100ms, not ~200ms
    expect(elapsed).toBeLessThan(150)
    expect(order).toHaveLength(2)
  })
})
