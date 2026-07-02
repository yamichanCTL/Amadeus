export class TextInjectionCancelledError extends Error {
  constructor() {
    super('文本注入已被更新的请求取消')
    this.name = 'TextInjectionCancelledError'
  }
}

export async function runTextInjectionWithRecovery(
  attempt: () => Promise<boolean>,
  reset: () => void,
  maxAttempts = 2,
): Promise<boolean> {
  let lastError: unknown
  for (let index = 0; index < Math.max(1, maxAttempts); index += 1) {
    try {
      // false is an intentional "focused control is not editable" result.
      // Retrying it can paste into a different target, so only exceptions retry.
      return await attempt()
    } catch (error) {
      lastError = error
      if (error instanceof TextInjectionCancelledError) break
      if (index + 1 >= maxAttempts) break
      reset()
    }
  }
  throw lastError instanceof Error ? lastError : new Error('文本注入失败')
}
