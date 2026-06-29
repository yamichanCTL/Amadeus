export class SupersededTaskError extends Error {
  constructor() {
    super('任务已被更新的请求取代')
    this.name = 'SupersededTaskError'
  }
}

/**
 * Serializes a non-reentrant OS operation, but never lets an active or queued
 * stale operation block the newest request. cancelActive must make the active
 * task settle; queued tasks check their generation before they start.
 */
export class LatestTaskQueue<T> {
  private generation = 0
  private active = false
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly cancelActive: () => void) {}

  run(task: () => Promise<T>): Promise<T> {
    const generation = ++this.generation
    if (this.active) {
      try {
        this.cancelActive()
      } catch {
        // The active promise remains the source of truth for cleanup.
      }
    }

    const result = this.tail.then(async () => {
      if (generation !== this.generation) throw new SupersededTaskError()
      this.active = true
      try {
        return await task()
      } finally {
        this.active = false
      }
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
