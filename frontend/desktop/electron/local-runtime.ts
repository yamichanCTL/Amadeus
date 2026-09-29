import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'

export interface LocalRuntimeState {
  phase: 'missing' | 'installing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error'
  installed: boolean
  url: string | null
  message: string
  error?: string
  autoStart: boolean
  root: string
  logPath: string
  progress?: number
  owned: boolean
}

interface RuntimeOptions {
  root: string
  bundlePath: string
  uvPath: string
  onChange?: (state: LocalRuntimeState) => void
}

interface SourceFile { relative: string; source: string }
const runtimeExtras = new Set(['whisper', 'sensevoice', 'qwen3asr', 'formalasr', 'firered', 'sherpa', 'x-asr'])

/** Logs are intended for user troubleshooting; provider credentials must stay private. */
export function redactRuntimeLog(value: string): string {
  return value
    .replace(/(authorization["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s,'"}]+/gi, '$1[已隐藏]')
    .replace(/((?:[a-z0-9_]*(?:api[_-]?key|token|secret|password)|credential)["']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|AIza[a-zA-Z0-9_-]{20,}|AQ\.[a-zA-Z0-9_-]{20,})/g, '[已隐藏]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[已隐藏]@')
    .replace(/\u001b\[[0-9;]*m/g, '')
}

function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false)
}

async function listSources(bundle: string): Promise<SourceFile[]> {
  const result: SourceFile[] = []
  for (const relative of ['pyproject.toml', 'uv.lock']) {
    const source = path.join(bundle, relative)
    if (!(await fs.lstat(source)).isFile()) throw new Error(`安装包文件不完整：${relative}`)
    result.push({ relative, source })
  }
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(bundle, relative)
    if (!(await fs.lstat(absolute)).isDirectory()) throw new Error(`安装包目录无效：${relative}`)
    const entries = (await fs.readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && /\.(py|json)$/.test(entry.name)) result.push({ relative: child, source: path.join(bundle, child) })
    }
  }
  await visit(path.join('backend', 'app'))
  await visit('runner')
  if (!result.some(file => file.relative === path.join('backend', 'app', 'main.py'))) throw new Error('安装包缺少后端入口。')
  return result
}

/** A generic status:ok service on an occupied port is never adopted. */
export async function isAmadeusReady(url: string): Promise<boolean> {
  const json = (pathname: string): Promise<Record<string, unknown> | null> => new Promise(resolve => {
    const request = http.get(new URL(pathname, url), { timeout: 1_500 }, response => {
      if (response.statusCode !== 200) { response.resume(); resolve(null); return }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
        if (body.length > 16_384) { response.destroy(); resolve(null) }
      })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
      response.on('error', () => resolve(null))
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(null))
  })
  const [root, health] = await Promise.all([json('/'), json('/v1/health')])
  return root?.message === 'Amadeus Backend' && health?.status === 'ok'
}

export async function findRuntimePort(preferred = 8768): Promise<number> {
  const bind = (port: number): Promise<number | null> => new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(null))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : null))
    })
  })
  return (await bind(preferred)) ?? (await bind(0)) ?? Promise.reject(new Error('无法分配本机端口。'))
}

/** All subprocesses use fixed executables/arguments. No renderer-provided command is executed. */
export class LocalRuntimeManager {
  private readonly appPath: string
  private readonly pythonPath: string
  private readonly markerPath: string
  private readonly preferencesPath: string
  private readonly ready: Promise<void>
  private readonly sourceBundle: Promise<{ files: SourceFile[]; fingerprint: string }>
  private state: LocalRuntimeState
  private queue: Promise<unknown> = Promise.resolve()
  private logQueue: Promise<void> = Promise.resolve()
  private child: ChildProcess | null = null
  private installer: ChildProcess | null = null
  private installation: Promise<LocalRuntimeState> | null = null
  private extraInstallation = false
  private disposed = false
  private stopping = false

  constructor(private readonly options: RuntimeOptions) {
    const root = path.resolve(options.root)
    if (!path.isAbsolute(options.root) || root === path.parse(root).root) throw new Error('本机环境目录必须是独立的绝对路径。')
    this.appPath = path.join(root, 'app')
    this.pythonPath = path.join(this.appPath, '.venv', 'Scripts', 'python.exe')
    this.markerPath = path.join(root, 'installation.json')
    this.preferencesPath = path.join(root, 'preferences.json')
    this.state = { phase: 'missing', installed: false, url: null, message: '首次使用，请安装本机环境。', autoStart: false, root, logPath: path.join(root, 'logs', 'backend.log'), owned: false }
    this.sourceBundle = this.inspectBundle()
    // Inspection failures are shown by status/install; never become an unhandled rejection.
    void this.sourceBundle.catch(() => undefined)
    this.ready = this.initialize()
  }

  private async inspectBundle(): Promise<{ files: SourceFile[]; fingerprint: string }> {
    const files = await listSources(this.options.bundlePath)
    const hash = createHash('sha256')
    for (const file of files) { hash.update(file.relative.replace(/\\/g, '/')); hash.update(await fs.readFile(file.source)) }
    return { files, fingerprint: hash.digest('hex') }
  }

  private async initialize(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.state.logPath), { recursive: true })
      try {
        const preferences = JSON.parse(await fs.readFile(this.preferencesPath, 'utf8'))
        this.state.autoStart = preferences.autoStart === true
      } catch { /* First run or an interrupted preference write uses safe defaults. */ }
      const { fingerprint } = await this.sourceBundle
      let marker: { fingerprint?: string } = {}
      try { marker = JSON.parse(await fs.readFile(this.markerPath, 'utf8')) } catch { /* Not installed yet. */ }
      this.state.installed = marker.fingerprint === fingerprint && await exists(this.pythonPath)
      if (this.state.installed) this.update({ phase: 'ready', message: '本机环境已安装，可以启动。' })
      else this.update({ message: marker.fingerprint ? '安装包已更新，请更新本机环境。已有配置和数据会保留。' : this.state.message })
    } catch (error) { this.fail(error) }
  }

  private update(next: Partial<LocalRuntimeState>): void {
    this.state = { ...this.state, ...next }
    try { this.options.onChange?.({ ...this.state }) } catch { /* Closing windows must not interrupt cleanup. */ }
  }

  private fail(error: unknown): void {
    const text = redactRuntimeLog(error instanceof Error ? error.message : String(error)).slice(-1_000)
    this.update({ phase: 'error', message: text, error: text, progress: undefined, owned: this.child !== null, url: this.child ? this.state.url : null })
    this.log(`错误：${text}`)
  }

  private log(text: string): void {
    const safe = `[${new Date().toISOString()}] ${redactRuntimeLog(text)}\n`
    this.logQueue = this.logQueue.then(async () => {
      await fs.mkdir(path.dirname(this.state.logPath), { recursive: true })
      const stat = await fs.stat(this.state.logPath).catch(() => null)
      if (stat && stat.size > 5 * 1024 * 1024) await fs.rename(this.state.logPath, `${this.state.logPath}.previous`).catch(() => undefined)
      await fs.appendFile(this.state.logPath, safe, 'utf8')
    }).catch(() => undefined)
  }

  private capture(child: ChildProcess, installation = false): void {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        pending += chunk
        const lines = pending.split(/[\r\n]+/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) this.log(line)
        if (pending.length > 65_536) { this.log(pending); pending = '' }
        if (installation) {
          const combined = lines.join(' ')
          if (/Downloading|download/i.test(combined)) this.update({ message: '正在下载 Python 和依赖，请保持联网……', progress: 30 })
          if (/Installing|Prepared|Uninstalled/i.test(combined)) this.update({ message: '正在安装并校验后端依赖……', progress: 70 })
        }
      })
      stream.on('end', () => { if (pending.trim()) this.log(pending) })
    }
  }

  private mutate(action: () => Promise<void>): Promise<LocalRuntimeState> {
    const operation = this.queue.then(async () => {
      await this.ready
      if (this.disposed) return { ...this.state }
      try { await action() } catch (error) { if (!this.disposed) this.fail(error) }
      return { ...this.state }
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private environment(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    // Parent Python/uv project settings must not escape this isolated environment.
    for (const name of ['VIRTUAL_ENV', 'PYTHONHOME', 'PYTHONPATH', 'UV_PROJECT_ENVIRONMENT', 'UV_PYTHON', 'UV_WORKING_DIRECTORY', 'UV_PROJECT']) delete env[name]
    return { ...env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', UV_NO_CONFIG: '1', UV_NATIVE_TLS: 'true', UV_PYTHON_PREFERENCE: 'only-managed',
      UV_PYTHON_INSTALL_DIR: path.join(this.state.root, 'python'), UV_CACHE_DIR: path.join(this.state.root, 'cache'),
      UV_PYTHON_BIN_DIR: path.join(this.state.root, 'bin'), UV_PYTHON_INSTALL_REGISTRY: 'false', UV_LINK_MODE: 'copy',
      UV_HTTP_TIMEOUT: '120', UV_NO_PROGRESS: '1', UV_PYTHON_DOWNLOADS: 'automatic' }
  }

  async status(): Promise<LocalRuntimeState> { await this.ready; return { ...this.state } }
  getRootPath(): string { return this.state.root }
  getLogPath(): string { return this.state.logPath }

  install(extra?: string): Promise<LocalRuntimeState> {
    if (extra && !runtimeExtras.has(extra)) return Promise.reject(new Error('不支持的运行组件。'))
    if (this.installation) return this.installation
    const operation = this.mutate(async () => {
      if (process.platform !== 'win32') throw new Error('一键环境安装目前支持 Windows 10/11。')
      if (this.child) throw new Error('请先停止本机后端再更新环境。')
      if (!await exists(this.options.uvPath)) throw new Error('安装包缺少环境安装器，请重新下载安装完整的 Windows 版本。')
      const repairing = this.state.installed
      const extrasPath = path.join(this.state.root, 'extras.json')
      let extras: string[] = []
      try {
        const saved: unknown = JSON.parse(await fs.readFile(extrasPath, 'utf8'))
        if (Array.isArray(saved)) extras = saved.filter((value): value is string => typeof value === 'string' && runtimeExtras.has(value))
      } catch { /* Basic environment or no extras selected yet. */ }
      if (extra && !extras.includes(extra)) extras.push(extra)
      this.update({ phase: 'installing', progress: 5, message: '正在准备独立的 Python 环境……', error: undefined, url: null })
      const bundle = await this.sourceBundle
      for (const file of bundle.files) {
        const destination = path.join(this.appPath, file.relative)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.copyFile(file.source, destination)
      }
      this.log('开始安装 Python 3.12 及锁定的后端依赖。')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.options.uvPath, ['sync', '--locked', '--no-dev', '--python', '3.12', '--project', this.appPath, ...extras.flatMap(value => ['--extra', value]), ...(repairing && !extra ? ['--reinstall'] : [])], { cwd: this.appPath, env: this.environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
        this.installer = child
        this.capture(child, true)
        const timeout = setTimeout(() => {
          void this.terminateOwned(child).then(() => reject(new Error('安装超过 30 分钟。请检查网络后重试；已下载的文件会复用。')))
        }, 30 * 60_000)
        const finish = (error?: Error) => {
          clearTimeout(timeout)
          if (this.installer === child) this.installer = null
          error ? reject(error) : resolve()
        }
        child.once('error', error => finish(new Error(`无法运行环境安装器：${error.message}`)))
        child.once('close', (code, signal) => finish(code === 0 ? undefined : new Error(`环境安装未完成（${code ?? signal}）。请检查网络连接及磁盘空间，打开日志查看原因后重试。`)))
      })
      if (this.disposed) return
      if (!await exists(this.pythonPath)) throw new Error('依赖安装结束但找不到 Python，请打开日志后重试安装。')
      await fs.writeFile(extrasPath, JSON.stringify(extras), 'utf8')
      await fs.writeFile(this.markerPath, JSON.stringify({ version: 1, fingerprint: bundle.fingerprint, installedAt: new Date().toISOString() }, null, 2), 'utf8')
      this.update({ phase: 'ready', installed: true, progress: 100, message: '环境安装完成。点击启动即可使用。', error: undefined })
    })
    this.installation = operation
    void operation.finally(() => { if (this.installation === operation) this.installation = null })
    return operation
  }

  async installExtra(extra: string): Promise<LocalRuntimeState> {
    if (!runtimeExtras.has(extra)) throw new Error('不支持的运行组件。')
    if (this.installation || this.extraInstallation) throw new Error('请等待当前安装完成。')
    // The complete stop/install/start sequence is one operation. Without this guard,
    // a second request can reuse the first install promise and silently lose its extra.
    this.extraInstallation = true
    try {
      const before = await this.status()
      if (!before.installed) throw new Error('请先安装基础运行环境。')
      if (!before.owned || before.phase !== 'running') throw new Error('请先启动本机服务。')
      const stopped = await this.stop()
      if (stopped.owned || stopped.phase === 'error') return stopped
      const installed = await this.install(extra)
      return installed.phase === 'ready' ? await this.start() : installed
    } finally { this.extraInstallation = false }
  }

  start(): Promise<LocalRuntimeState> {
    return this.mutate(async () => {
      if (this.child && this.state.phase === 'running') return
      if (!this.state.installed || !await exists(this.pythonPath)) throw new Error('请先点击“安装本机环境”，完成后再启动。')
      if (this.child) await this.stopChild()
      this.update({ phase: 'starting', progress: undefined, message: '正在启动本机后端……', error: undefined, url: null })
      const port = await findRuntimePort()
      const url = `http://127.0.0.1:${port}`
      const env = { ...this.environment(), PROJECT_ROOT: this.state.root, MODELS_DIR: path.join(this.state.root, 'models'),
        CODEX_RUNTIME_DIR: path.join(this.state.root, 'codex'), PRELOAD_DEFAULT_ENGINE: 'false', CELERY_TASK_ALWAYS_EAGER: 'true', APP_ENV: 'production' }
      const child = spawn(this.pythonPath, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], { cwd: path.join(this.appPath, 'backend'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      this.child = child
      this.update({ owned: true })
      this.capture(child)
      let exited = false
      let failure = ''
      child.once('error', error => { exited = true; failure = error.message })
      child.once('exit', (code, signal) => {
        exited = true
        failure ||= `退出代码 ${code ?? signal}`
        if (this.child === child) {
          this.child = null
          if (!this.stopping && !this.disposed && this.state.phase === 'running') this.fail(new Error(`本机后端意外退出（${failure}）。请打开日志后重新启动。`))
        }
      })
      try {
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          if (this.disposed) { await this.terminateOwned(child); return }
          if (exited) throw new Error(`本机后端启动失败（${failure}）。请打开日志查看原因。`)
          if (await isAmadeusReady(url)) {
            // Do not accept a service that raced us to the port after our own child exited.
            await new Promise(resolve => setTimeout(resolve, 150))
            if (exited) throw new Error(`后端未能占用启动端口（${failure}），请重新启动。`)
            this.log(`本机后端已就绪：${url}`)
            this.update({ phase: 'running', url, owned: true, message: '本机后端已启动，可在此窗口直接使用。' })
            return
          }
          await new Promise(resolve => setTimeout(resolve, 300))
        }
        throw new Error('本机后端 90 秒内未就绪，请打开日志查看原因后重新启动。')
      } catch (error) { await this.stopChild(); throw error }
    })
  }

  private terminateOwned(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        // Venv's Windows launcher can own another Python process. Only this still-live
        // ChildProcess tree is terminated; no persisted PID or process-name lookup is used.
        execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, error => {
          if (error && child.exitCode === null && child.signalCode === null) reject(new Error('未能停止本次启动的后端进程，请重试停止或退出应用。'))
          else resolve()
        })
      } else {
        child.kill('SIGTERM')
        const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve() }, 3_000)
        child.once('exit', () => { clearTimeout(timeout); resolve() })
      }
    })
  }

  private async stopChild(): Promise<void> {
    this.stopping = true
    const child = this.child
    try {
      if (child) await this.terminateOwned(child)
      if (this.child === child) this.child = null
      this.update({ url: null, owned: false })
    } finally { this.stopping = false }
  }

  stop(): Promise<LocalRuntimeState> {
    return this.mutate(async () => {
      this.update({ phase: 'stopping', message: '正在停止本机后端……' })
      await this.stopChild()
      this.update({ phase: this.state.installed ? 'ready' : 'missing', message: this.state.installed ? '本机后端已停止，环境会保留。' : '首次使用，请安装本机环境。', error: undefined, progress: undefined })
    })
  }

  setAutoStart(autoStart: boolean): Promise<LocalRuntimeState> {
    return this.mutate(async () => {
      if (typeof autoStart !== 'boolean') throw new Error('无效的自动启动设置。')
      await fs.writeFile(`${this.preferencesPath}.tmp`, JSON.stringify({ autoStart }), 'utf8')
      await fs.rename(`${this.preferencesPath}.tmp`, this.preferencesPath)
      this.update({ autoStart })
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.ready
    if (this.installer) await this.terminateOwned(this.installer)
    await this.stopChild()
    await this.queue
    await this.logQueue
  }
}
