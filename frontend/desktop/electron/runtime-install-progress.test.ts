// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeInstallObserver, sampleRuntimeCache, type RuntimeInstallProgress } from './runtime-install-progress'
import type { RuntimeInstallProgress as RendererProgress } from '../src/services/localRuntimeTypes'

const temporary: string[] = []
const observers: RuntimeInstallObserver[] = []
afterEach(async () => {
  for (const observer of observers.splice(0)) observer.stop('cancelled')
  vi.useRealTimers()
  for (const directory of temporary.splice(0)) {
    const resolved = path.resolve(directory)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('amadeus-progress-')) throw new Error('Unsafe test cleanup target')
    await fs.rm(resolved, { recursive: true, force: true })
  }
})

function create(lock = '') {
  const events: RuntimeInstallProgress[] = []
  const observer = new RuntimeInstallObserver(lock, [], event => events.push(event))
  observers.push(observer)
  return { observer, events }
}

describe('uv installation observations', () => {
  it('uses actual events and rounded log sizes without inventing live bytes, speeds or a lockfile total', () => {
    const { observer } = create('[[package]]\nname = "torch"\nversion = "2.10.0"\n[[package]]\nname = "not-selected"\nversion = "99.0"')
    observer.consume('Downloading cpython-3.12.12-windows-x86_64-none (download) (29.4MiB)')
    observer.consume('Downloaded cpython-3.12.12-windows-x86_64-none (download)')
    observer.consume('Extracting cpython-3.12.12-windows-x86_64-none (extract) (99.8MiB)')
    observer.consume('Extracted cpython-3.12.12-windows-x86_64-none (extract)')
    observer.consume('Using CPython 3.12.12 interpreter at: C:\\private\\python.exe')
    observer.consume('Resolved 142 packages in 3ms')
    observer.consume('\u001b[36mDownloading torch (110.2MiB)\u001b[0m')
    const snapshot = observer.snapshot()
    const rendererContract: RendererProgress = snapshot
    expect(rendererContract.observedItems).toBe(2)
    expect(snapshot.resolvedPackages).toBe(142)
    expect(snapshot.items[0]).toMatchObject({ name: 'Python', version: '3.12.12', status: 'prepared', totalBytes: Math.round(29.4 * 1024 ** 2) })
    expect(snapshot.items[1]).toEqual({ id: 'torch', name: 'torch', version: '2.10.0', kind: 'package', status: 'downloading', totalBytes: Math.round(110.2 * 1024 ** 2), totalBytesApproximate: true, sizeSource: 'uv-log' })
    expect(snapshot).not.toHaveProperty('progress')
    expect(snapshot.items.some(item => item.downloadedBytes !== undefined || item.bytesPerSecond !== undefined)).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('private')
    observer.consume('Downloaded torch')
    observer.consume('Prepared 14 packages in 21s')
    observer.consume('Installed 28 packages in 16ms')
    observer.consume(' + torch==2.10.0 (from https://user:secret@example.com/file.whl)')
    observer.stop('complete')
    expect(observer.snapshot()).toMatchObject({ stage: 'complete', observedItems: 2, completedItems: 2, preparedPackages: 14, installedPackages: 28 })
    expect(JSON.stringify(observer.snapshot())).not.toContain('secret')
  })

  it('does not guess a version from multiple Python/platform alternatives or invent sizes for unreported downloads', () => {
    const { observer } = create('[[package]]\nname = "numpy"\nversion = "1.26.4"\n[[package]]\nname = "numpy"\nversion = "2.4.4"')
    observer.consume('Downloading numpy')
    expect(observer.snapshot().items[0]).toMatchObject({ name: 'numpy', status: 'downloading' })
    expect(observer.snapshot().items[0].version).toBeUndefined()
    expect(observer.snapshot().items[0].totalBytes).toBeUndefined()
    observer.consume(' + numpy==2.4.4')
    observer.consume(' + small-cached-package==1.2.3')
    expect(observer.snapshot().items[0].version).toBe('2.4.4')
    expect(observer.snapshot().items[1]).toEqual({ id: 'small-cached-package', name: 'small-cached-package', version: '1.2.3', kind: 'package', status: 'installed' })
  })

  it('keeps a heartbeat separate from the last event and ignores late lines after cancellation', async () => {
    vi.useFakeTimers()
    const { observer, events } = create()
    observer.start()
    observer.consume('Downloading torch (110.2MiB)')
    const eventTime = observer.snapshot().lastEventAt
    await vi.advanceTimersByTimeAsync(3_000)
    expect(observer.snapshot().updatedAt).toBeGreaterThan(eventTime)
    expect(observer.snapshot().lastEventAt).toBe(eventTime)
    observer.stop('cancelled')
    const count = events.length
    observer.consume('Downloaded torch')
    observer.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(events).toHaveLength(count)
    expect(observer.snapshot()).toMatchObject({ stage: 'cancelled', items: [{ status: 'cancelled' }] })
  })

  it('measures real disk file sizes including preexisting cache, without following a junction or counting it as network bytes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-progress-'))
    temporary.push(directory)
    const cache = path.join(directory, 'cache')
    const python = path.join(directory, 'python')
    const outside = path.join(directory, 'unrelated')
    await Promise.all([cache, python, outside].map(dir => fs.mkdir(dir)))
    await fs.writeFile(path.join(cache, 'existing'), Buffer.alloc(71))
    await fs.writeFile(path.join(python, 'python.exe'), Buffer.alloc(103))
    await fs.writeFile(path.join(outside, 'private'), Buffer.alloc(999))
    await fs.symlink(outside, path.join(cache, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await sampleRuntimeCache([cache, python, cache])).toMatchObject({ bytes: 174, files: 2, scope: 'uv-cache-and-python', partial: false })
    await fs.writeFile(path.join(cache, 'partial-download'), Buffer.alloc(512))
    expect(await sampleRuntimeCache([cache, python])).toMatchObject({ bytes: 686, files: 3, partial: false })
    expect(await sampleRuntimeCache([cache, python], () => false, 1)).toMatchObject({ partial: true })
    expect(await sampleRuntimeCache([cache, python], () => true)).toBeUndefined()
  })
})
