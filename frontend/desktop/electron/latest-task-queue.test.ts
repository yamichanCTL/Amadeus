// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { LatestTaskQueue, SupersededTaskError } from './latest-task-queue'

describe('LatestTaskQueue', () => {
  it('cancels a stuck active operation so the newest result completes within 500ms', async () => {
    let rejectActive: ((error: Error) => void) | null = null
    const queue = new LatestTaskQueue<string>(() => rejectActive?.(new Error('cancelled stale injection')))
    const first = queue.run(() => new Promise<string>((_resolve, reject) => { rejectActive = reject }))
    await new Promise((resolve) => setTimeout(resolve, 10))

    const startedAt = performance.now()
    const second = queue.run(async () => 'second')

    await expect(first).rejects.toThrow('cancelled stale injection')
    await expect(second).resolves.toBe('second')
    expect(performance.now() - startedAt).toBeLessThan(500)
  })

  it('skips queued intermediate requests and executes only the newest one', async () => {
    let rejectActive: ((error: Error) => void) | null = null
    const executed: string[] = []
    const queue = new LatestTaskQueue<string>(() => rejectActive?.(new Error('cancelled')))
    const first = queue.run(() => new Promise<string>((_resolve, reject) => { rejectActive = reject }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const middle = queue.run(async () => { executed.push('middle'); return 'middle' })
    const latest = queue.run(async () => { executed.push('latest'); return 'latest' })

    await expect(first).rejects.toThrow('cancelled')
    await expect(middle).rejects.toBeInstanceOf(SupersededTaskError)
    await expect(latest).resolves.toBe('latest')
    expect(executed).toEqual(['latest'])
  })

  it('keeps 30 normal consecutive operations ordered and below 500ms each', async () => {
    const queue = new LatestTaskQueue<number>(vi.fn())
    const latencies: number[] = []
    for (let round = 0; round < 30; round += 1) {
      const startedAt = performance.now()
      await expect(queue.run(async () => round)).resolves.toBe(round)
      latencies.push(performance.now() - startedAt)
    }
    expect(Math.max(...latencies)).toBeLessThan(500)
  })
})
