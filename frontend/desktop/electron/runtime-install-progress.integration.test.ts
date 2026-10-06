// @vitest-environment node
// Opt-in: use already present uv / managed Python, never download an interpreter or real dependencies.
import { expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { RuntimeInstallObserver, type RuntimeInstallProgress } from './runtime-install-progress'

const uv = process.env.AMADEUS_TEST_UV
const python = process.env.AMADEUS_TEST_MANAGED_PYTHON
const execute = promisify(execFile)

it.skipIf(!uv || !python)('observes a real uv loopback wheel install and cancels a slow transfer without a false completion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-progress-real-'))
  const wheel = path.join(directory, 'progress_fixture-1.0.0-py3-none-any.whl')
  const observers: RuntimeInstallObserver[] = []
  const children: ChildProcess[] = []
  const timers = new Set<ReturnType<typeof setInterval>>()
  let servedBytes = 0
  let data: Buffer
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Length', data.length)
    let offset = 0
    const timer = setInterval(() => {
      const chunk = data.subarray(offset, offset + 16_384)
      response.write(chunk)
      servedBytes += chunk.length
      offset += chunk.length
      if (offset >= data.length) { clearInterval(timer); timers.delete(timer); response.end() }
    }, 15)
    timers.add(timer)
    response.on('close', () => { clearInterval(timer); timers.delete(timer) })
  })
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    // This wheel-only fixture has no build subprocess tree. Use the owned child handle;
    // sandboxed Windows test runners may forbid taskkill's process lookup.
    if (!child.kill('SIGTERM')) throw new Error('Could not cancel the owned fixture downloader')
  }
  try {
    // A valid, uncompressed wheel is deliberately just above uv's 1 MiB pipe-log threshold.
    await execute(python!, ['-c', [
      'import zipfile,sys',
      "z=zipfile.ZipFile(sys.argv[1],'w')",
      "z.writestr('progress_fixture.py', '#'+('x'*1200000))",
      "z.writestr('progress_fixture-1.0.0.dist-info/METADATA','Metadata-Version: 2.1\\nName: progress-fixture\\nVersion: 1.0.0\\n')",
      "z.writestr('progress_fixture-1.0.0.dist-info/WHEEL','Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
      "z.writestr('progress_fixture-1.0.0.dist-info/RECORD','')",
      'z.close()',
    ].join('\n'), wheel], { windowsHide: true })
    data = await fs.readFile(wheel)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/${path.basename(wheel)}`

    async function run(name: string, cancel: boolean) {
      const root = path.join(directory, name)
      const cache = path.join(root, 'cache')
      const interpreterRoot = path.join(root, 'python')
      const events: RuntimeInstallProgress[] = []
      const observer = new RuntimeInstallObserver('[[package]]\nname = "progress-fixture"\nversion = "1.0.0"', [cache, interpreterRoot], value => events.push(value))
      observers.push(observer)
      observer.start()
      const child = spawn(uv!, ['pip', 'install', '--python', python!, '--target', path.join(root, 'target'), '--no-index', '--no-deps', url], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1', UV_PYTHON_DOWNLOADS: 'never', UV_PYTHON_PREFERENCE: 'only-managed', UV_CACHE_DIR: cache, UV_PYTHON_INSTALL_DIR: interpreterRoot },
      })
      children.push(child)
      let output = ''
      let cancellation: Promise<void> | undefined
      for (const stream of [child.stdout!, child.stderr!]) {
        let pending = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          output += chunk
          pending += chunk
          const lines = pending.split(/[\r\n]+/)
          pending = lines.pop() ?? ''
          for (const line of lines) observer.consume(line)
          if (cancel && !cancellation && /Downloading progress-fixture/.test(output)) {
            observer.stop('cancelled')
            cancellation = stop(child)
            void cancellation.catch(() => undefined)
          }
        })
        stream.on('end', () => { if (pending) observer.consume(pending) })
      }
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      await cancellation
      if (!cancel) {
        expect(result.code, output).toBe(0)
        observer.stop('complete')
        expect(observer.snapshot().items.find(item => item.name === 'progress-fixture')).toMatchObject({ version: '1.0.0', status: 'installed', totalBytesApproximate: true })
        expect(events.some(event => event.items.some(item => item.status === 'downloading'))).toBe(true)
        expect(await fs.readFile(path.join(root, 'target', 'progress_fixture.py'), 'utf8')).toHaveLength(1_200_001)
      } else {
        expect(cancellation).toBeDefined()
        expect(result.code !== 0 || result.signal !== null).toBe(true)
        expect(observer.snapshot().stage).toBe('cancelled')
        await expect(fs.access(path.join(root, 'target', 'progress_fixture-1.0.0.dist-info', 'METADATA'))).rejects.toThrow()
        const count = events.length
        observer.consume('Downloaded progress-fixture')
        await new Promise(resolve => setTimeout(resolve, 1_050))
        expect(events).toHaveLength(count)
      }
      expect(events.every(event => event.items.every(item => item.downloadedBytes === undefined && item.bytesPerSecond === undefined))).toBe(true)
    }
    await run('complete', false)
    await run('cancelled', true)
    expect(servedBytes).toBeGreaterThan(data.length)
  } finally {
    for (const observer of observers) observer.stop('cancelled')
    for (const child of children) await stop(child).catch(() => undefined)
    for (const timer of timers) clearInterval(timer)
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    const resolved = path.resolve(directory)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('amadeus-progress-real-')) throw new Error('Unsafe fixture cleanup target')
    await fs.rm(resolved, { recursive: true, force: true })
  }
}, 30_000)
