import fs from 'node:fs/promises'
import path from 'node:path'

export type SummaryLogEntry = {
  name: string
  path: string
  modifiedAt: string
  content: string
}

export async function listSummaryLogs(root: string, date: string): Promise<SummaryLogEntry[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  const dir = path.join(root, 'summary-logs', date)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const entries = await Promise.all(names
    .filter((name) => name.toLowerCase().endsWith('.md') && path.basename(name) === name)
    .map(async (name) => {
      const target = path.join(dir, name)
      const [stats, content] = await Promise.all([fs.stat(target), fs.readFile(target, 'utf8')])
      if (!stats.isFile()) return null
      return { name, path: target, modifiedAt: stats.mtime.toISOString(), content }
    }))

  return entries
    .filter((entry): entry is SummaryLogEntry => Boolean(entry))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}
