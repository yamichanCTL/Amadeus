import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSummaryLogs } from './summary-log-layout'

describe('summary log loading', () => {
  it('lists generated Markdown newest first and includes displayable content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-summary-'))
    try {
      const dir = path.join(root, 'summary-logs', '2026-07-04')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'older.md'), '# 旧总结', 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 5))
      await fs.writeFile(path.join(dir, 'newer.md'), '# 新总结', 'utf8')

      const logs = await listSummaryLogs(root, '2026-07-04')

      expect(logs.map((item) => item.name)).toEqual(['newer.md', 'older.md'])
      expect(logs[0].content).toBe('# 新总结')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects invalid dates instead of escaping the summary directory', async () => {
    await expect(listSummaryLogs('/archive', '../private')).resolves.toEqual([])
  })
})
