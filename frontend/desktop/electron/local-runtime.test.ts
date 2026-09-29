// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { LocalRuntimeManager, findRuntimePort, isAmadeusReady, redactRuntimeLog } from './local-runtime'

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))

class FakeChild extends EventEmitter {
  pid = 920_000 + Math.floor(Math.random() * 10_000)
  exitCode: number | null = null
  signalCode: string | null = null
  stdout = new PassThrough()
  stderr = new PassThrough()
  server?: http.Server
  finish(code = 0): void {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, null)
    this.emit('close', code, null)
    this.server?.close()
  }
}

let temporary: string
let bundle: string
let root: string
let uvPath: string
let manager: LocalRuntimeManager
let children: FakeChild[]
let servers: http.Server[]
let terminateFails = false

async function serve(handler: http.RequestListener): Promise<{ server: http.Server; url: string; port: number }> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { server, port: address.port, url: `http://127.0.0.1:${address.port}` }
}

beforeEach(async () => {
  vi.clearAllMocks()
  children = []
  servers = []
  terminateFails = false
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-runtime-'))
  bundle = path.join(temporary, 'bundle')
  root = path.join(temporary, '用户 环境')
  uvPath = path.join(temporary, 'uv.exe')
  for (const [relative, text] of Object.entries({ 'pyproject.toml': '[project]\nname="fixture"', 'uv.lock': 'version=1', 'backend/app/main.py': '# fixture', 'backend/app/core/voices.json': '{}', 'runner/__init__.py': '', 'backend/.env': 'SECRET=must-not-copy', 'runner/__pycache__/private.pyc': 'private' })) {
    const file = path.join(bundle, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  }
  await fs.writeFile(uvPath, '')
  vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: { cwd: string }) => {
    const child = new FakeChild()
    children.push(child)
    if (command === uvPath) {
      setImmediate(() => { void (async () => {
        const python = path.join(options.cwd, '.venv', 'Scripts', 'python.exe')
        await fs.mkdir(path.dirname(python), { recursive: true })
        await fs.writeFile(python, '')
        child.stdout.write('Installed dependencies\n')
        child.finish()
      })() })
    } else {
      const port = Number(args[args.indexOf('--port') + 1])
      const server = http.createServer((request, response) => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(request.url === '/' ? { message: 'Amadeus Backend' } : { status: 'ok' }))
      })
      servers.push(server)
      child.server = server
      server.listen(port, '127.0.0.1')
    }
    return child
  }) as typeof spawn)
  vi.mocked(execFile).mockImplementation(((command: string, args: string[], options: unknown, callback: (error: Error | null) => void) => {
    if (terminateFails) { callback(new Error('access denied')); return }
    const child = children.find(item => item.pid === Number(args[1]))
    child?.finish()
    callback(null)
  }) as typeof execFile)
  manager = new LocalRuntimeManager({ root, bundlePath: bundle, uvPath })
})

afterEach(async () => {
  terminateFails = false
  await manager.dispose()
  for (const child of children) if (child.exitCode === null) child.finish()
  await Promise.all(servers.filter(server => server.listening).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  const resolved = path.resolve(temporary)
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('amadeus-runtime-')) throw new Error('Unsafe test cleanup target')
  await fs.rm(resolved, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('Windows managed environment lifecycle', () => {
  it('installs only allowlisted sources, deduplicates a double click and repairs an installed environment', async () => {
    const first = manager.install()
    expect(manager.install()).toBe(first)
    expect((await first).phase).toBe('ready')
    expect(spawn).toHaveBeenCalledTimes(1)
    const spawnOptions = vi.mocked(spawn).mock.calls[0][2]!
    expect(spawnOptions).toMatchObject({ windowsHide: true, shell: false, env: { UV_PYTHON_PREFERENCE: 'only-managed', UV_NATIVE_TLS: 'true', UV_NO_CONFIG: '1' } })
    expect(await fs.readFile(path.join(root, 'app/backend/app/core/voices.json'), 'utf8')).toBe('{}')
    await expect(fs.access(path.join(root, 'app/backend/.env'))).rejects.toThrow()
    await expect(fs.access(path.join(root, 'app/runner/__pycache__'))).rejects.toThrow()
    const localEnv = path.join(root, 'app/backend/.env')
    await fs.writeFile(localEnv, 'USER_CONFIGURATION=keep')
    expect((await manager.install()).phase).toBe('ready')
    expect(vi.mocked(spawn).mock.calls[1][1]).toContain('--reinstall')
    expect(await fs.readFile(localEnv, 'utf8')).toBe('USER_CONFIGURATION=keep')
  })

  it('does not start after install until requested, and starts only one owned backend', async () => {
    await manager.install()
    expect((await manager.status()).url).toBeNull()
    const [first, second] = await Promise.all([manager.start(), manager.start()])
    expect(first.phase).toBe('running')
    expect(second.url).toBe(first.url)
    expect(first.owned).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(await isAmadeusReady(first.url!)).toBe(true)
    const child = children[1]
    const stopped = await manager.stop()
    expect(stopped).toMatchObject({ phase: 'ready', owned: false, url: null })
    expect(vi.mocked(execFile).mock.calls[0][1]).toEqual(['/PID', String(child.pid), '/T', '/F'])
  })

  it('preserves ownership and reports failure when Windows rejects process termination', async () => {
    await manager.install()
    await manager.start()
    terminateFails = true
    expect(await manager.stop()).toMatchObject({ phase: 'error', owned: true })
    expect((await manager.status()).error).toContain('未能停止')
    terminateFails = false
    expect(await manager.stop()).toMatchObject({ phase: 'ready', owned: false, url: null })
  })

  it('never terminates or adopts an external service', async () => {
    const external = await serve((_request, response) => response.end(JSON.stringify({ status: 'ok' })))
    expect(await isAmadeusReady(external.url)).toBe(false)
    const freePort = await findRuntimePort(external.port)
    expect(freePort).not.toBe(external.port)
    await manager.stop()
    expect(execFile).not.toHaveBeenCalled()
    expect(external.server.listening).toBe(true)
  })

  it('persists automatic start without starting a process from the preference toggle', async () => {
    await manager.setAutoStart(true)
    expect((await manager.status()).autoStart).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
    const reopened = new LocalRuntimeManager({ root, bundlePath: bundle, uvPath })
    try { expect((await reopened.status()).autoStart).toBe(true) } finally { await reopened.dispose() }
  })

  it('invalidates installation when bundled backend code changes', async () => {
    await manager.install()
    await fs.writeFile(path.join(bundle, 'backend/app/main.py'), '# changed')
    const reopened = new LocalRuntimeManager({ root, bundlePath: bundle, uvPath })
    try {
      const status = await reopened.status()
      expect(status.installed).toBe(false)
      expect(status.message).toContain('更新')
    } finally { await reopened.dispose() }
  })

  it('installs an extra only after stopping the owned backend, then restarts it', async () => {
    await manager.install()
    await manager.start()
    const previousChild = children[1]
    const result = await manager.installExtra('whisper')
    expect(result).toMatchObject({ phase: 'running', owned: true, installed: true })
    expect(previousChild.exitCode).toBe(0)
    expect(children).toHaveLength(4)
    expect(spawn).toHaveBeenNthCalledWith(3, uvPath, expect.arrayContaining(['--extra', 'whisper']), expect.anything())
    expect(vi.mocked(execFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(spawn).mock.invocationCallOrder[2])
    expect(vi.mocked(spawn).mock.calls[3][0]).toBe(path.join(root, 'app/.venv/Scripts/python.exe'))
    expect(await isAmadeusReady(result.url!)).toBe(true)
  })

  it('persists cumulative extras and reinstalls them during a later repair', async () => {
    await manager.install()
    await manager.start()
    await manager.installExtra('whisper')
    await manager.installExtra('x-asr')
    await manager.stop()
    const reopened = new LocalRuntimeManager({ root, bundlePath: bundle, uvPath })
    try {
      expect((await reopened.install()).phase).toBe('ready')
      const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] || []
      expect(args).toEqual(expect.arrayContaining(['--extra', 'whisper', '--extra', 'x-asr', '--reinstall']))
      expect(JSON.parse(await fs.readFile(path.join(root, 'extras.json'), 'utf8'))).toEqual(['whisper', 'x-asr'])
    } finally { await reopened.dispose() }
  })

  it('rejects unsupported extras without stopping the current backend or spawning anything', async () => {
    await manager.install()
    await manager.start()
    const count = vi.mocked(spawn).mock.calls.length
    await expect(manager.installExtra('unknown-package')).rejects.toThrow('不支持')
    await expect(manager.install('--index-url=untrusted')).rejects.toThrow('不支持')
    expect(spawn).toHaveBeenCalledTimes(count)
    expect(execFile).not.toHaveBeenCalled()
    expect((await manager.status()).phase).toBe('running')
  })

  it('rejects overlapping extra requests instead of silently losing the second selection', async () => {
    await manager.install()
    await manager.start()
    const first = manager.installExtra('whisper')
    await expect(manager.installExtra('x-asr')).rejects.toThrow('请等待')
    expect((await first).phase).toBe('running')
    expect(JSON.parse(await fs.readFile(path.join(root, 'extras.json'), 'utf8'))).toEqual(['whisper'])
    expect((await manager.installExtra('x-asr')).phase).toBe('running')
    expect(JSON.parse(await fs.readFile(path.join(root, 'extras.json'), 'utf8'))).toEqual(['whisper', 'x-asr'])
  })

  it('does not alter dependencies when stopping the owned backend fails', async () => {
    await manager.install()
    await manager.start()
    terminateFails = true
    expect(await manager.installExtra('whisper')).toMatchObject({ phase: 'error', owned: true })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await fs.readFile(path.join(root, 'extras.json'), 'utf8'))).toEqual([])
  })

  it('keeps an install failure visible and does not restart a partially changed environment', async () => {
    await manager.install()
    await manager.start()
    vi.mocked(spawn).mockImplementationOnce((() => {
      const child = new FakeChild()
      children.push(child)
      setImmediate(() => child.finish(1))
      return child
    }) as typeof spawn)
    expect(await manager.installExtra('whisper')).toMatchObject({ phase: 'error', owned: false })
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(JSON.parse(await fs.readFile(path.join(root, 'extras.json'), 'utf8'))).toEqual([])
  })
})

describe('runtime troubleshooting logs', () => {
  it('redacts authorization, JSON credentials, URL credentials and common provider key formats', () => {
    for (const input of ['Authorization: Bearer secret-value', '{"api_key": "secret-value"}', 'GEMINI_API_KEY=secret-value', 'https://name:secret-value@example.com', 'sk-abcdefghijklmnopqrstuv']) {
      const safe = redactRuntimeLog(input)
      expect(safe).not.toContain('secret-value')
      expect(safe).not.toContain('sk-abcdefghijklmnopqrstuv')
      expect(safe).toContain('[已隐藏]')
    }
  })
})
