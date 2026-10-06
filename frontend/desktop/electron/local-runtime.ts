import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { RuntimeInstallObserver, runtimeInstallMessages, type RuntimeInstallProgress } from './runtime-install-progress'
import { managedRuntimeEnvironment, type ManagedStoragePaths } from './storage-layout'

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
  installProgress?: RuntimeInstallProgress
  owned: boolean
}

interface RuntimeOptions {
  root: string
  bundlePath: string
  uvPath: string
  storagePaths?: ManagedStoragePaths
  onChange?: (state: LocalRuntimeState) => void
}

interface SourceFile { relative: string; source: string }
const runtimeExtras = new Set(['whisper', 'sensevoice', 'qwen3asr', 'formalasr', 'firered', 'sherpa', 'x-asr'])
const runtimeModules: Record<string, string[]> = {
  whisper: ['faster_whisper'], sensevoice: ['funasr', 'torch', 'torchaudio', 'kaldi_native_fbank'],
  qwen3asr: ['qwen_asr', 'torch', 'transformers', 'accelerate'],
  formalasr: ['qwen_asr', 'torch', 'transformers', 'accelerate'],
  firered: ['torch', 'torchaudio', 'transformers', 'kaldi_native_fbank', 'kaldiio', 'cn2an', 'peft'],
  sherpa: ['sherpa_onnx'], 'x-asr': ['sherpa_onnx'],
}

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
  private installObserver: RuntimeInstallObserver | null = null
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

  private capture(child: ChildProcess, onLine?: (line: string) => void): void {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue
      let pending = ''
      const report = (line: string) => {
        if (this.disposed) return
        if (line.trim()) { this.log(line); onLine?.(redactRuntimeLog(line)) }
      }
      const flush = () => { report(pending); pending = '' }
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        pending += chunk
        const lines = pending.split(/[\r\n]+/)
        pending = lines.pop() ?? ''
        for (const line of lines) report(line)
        if (pending.length > 65_536) flush()
      })
      stream.on('end', flush)
      child.once('close', flush)
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
      UV_HTTP_TIMEOUT: '120', UV_NO_PROGRESS: '1', UV_PYTHON_DOWNLOADS: 'automatic',
      ...(this.options.storagePaths ? managedRuntimeEnvironment(this.options.storagePaths) : {}) }
  }

  async status(): Promise<LocalRuntimeState> { await this.ready; return { ...this.state } }
  getRootPath(): string { return this.state.root }
  getLogPath(): string { return this.state.logPath }

  install(extra?: string): Promise<LocalRuntimeState> {
    if (extra && !runtimeExtras.has(extra)) return Promise.reject(new Error('不支持的运行组件。'))
    if (this.installation) return this.installation
    const operation = this.mutate(async () => {
      if (process.platform !== 'win32') throw new Error('一键环境安装目前支持 Windows 10/11。')
      if (this.child) await this.stopChild()
      if (!await exists(this.options.uvPath)) throw new Error('安装包缺少环境安装器，请重新下载安装完整的 Windows 版本。')
      const repairing = this.state.installed
      const extrasPath = path.join(this.state.root, 'extras.json')
      let extras: string[] = []
      try {
        const saved: unknown = JSON.parse(await fs.readFile(extrasPath, 'utf8'))
        if (Array.isArray(saved)) extras = saved.filter((value): value is string => typeof value === 'string' && runtimeExtras.has(value))
      } catch { /* Basic environment or no extras selected yet. */ }
      if (extra && !extras.includes(extra)) extras.push(extra)
      this.update({ phase: 'installing', progress: undefined, installProgress: undefined, message: '正在准备独立的 Python 环境……', error: undefined, url: null })
      const bundle = await this.sourceBundle
      const storage = this.options.storagePaths
      if (storage) await Promise.all([storage.pythonRoot, storage.modelsRoot, storage.cacheRoot, storage.tempRoot, storage.backendDataRoot].map(directory => fs.mkdir(directory, { recursive: true })))
      const environment = this.environment()
      const observer = new RuntimeInstallObserver(await fs.readFile(path.join(this.options.bundlePath, 'uv.lock'), 'utf8'), [environment.UV_CACHE_DIR!, environment.UV_PYTHON_INSTALL_DIR!], installProgress => {
        if (!this.disposed && this.installObserver === observer) this.update({ installProgress, message: runtimeInstallMessages[installProgress.stage], progress: undefined })
      })
      this.installObserver = observer
      observer.start()
      try {
        for (const file of bundle.files) {
          const destination = path.join(this.appPath, file.relative)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.copyFile(file.source, destination)
        }
        if (this.disposed) return
        this.log('开始安装 Python 3.12 及锁定的后端依赖。')
        // A failed dependency change must not retain a marker claiming that the
        // previous environment still satisfies the current package.
        await fs.rm(this.markerPath, { force: true })
        this.update({ installed: false })
        await new Promise<void>((resolve, reject) => {
          const child = spawn(this.options.uvPath, ['sync', '--locked', '--no-dev', '--python', '3.12', '--project', this.appPath, ...extras.flatMap(value => ['--extra', value]), ...(repairing && !extra ? ['--reinstall'] : [])], { cwd: this.appPath, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
          this.installer = child
          const recentErrors: string[] = []
          this.capture(child, line => {
            observer.consume(line)
            if (/error:|caused by:|failed to|no solution|certificate|×/i.test(line)) {
              recentErrors.push(line.trim())
              if (recentErrors.length > 4) recentErrors.shift()
            }
          })
          let settled = false
          let timeoutError: Error | undefined
          const timeout = setTimeout(() => {
            timeoutError = new Error('安装超过 30 分钟。请检查网络后重试；已下载的文件会复用。')
            void this.terminateOwned(child).then(() => finish(timeoutError), error => finish(error))
          }, 30 * 60_000)
          const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (this.installer === child) this.installer = null
            const failure = timeoutError ?? error
            failure ? reject(failure) : resolve()
          }
          child.once('error', error => finish(new Error(`无法运行环境安装器：${error.message}`)))
          child.once('close', (code, signal) => finish(code === 0 ? undefined : new Error(`环境安装未完成（${code ?? signal}）。${recentErrors.length ? recentErrors.join(' ').slice(-600) : '请检查网络连接及磁盘空间，打开日志查看原因后重试。'}`)))
        })
        if (this.disposed) return
        if (!await exists(this.pythonPath)) throw new Error('依赖安装结束但找不到 Python，请打开日志后重试安装。')
        if (extras.length) await this.verifyRuntimeComponents(extras)
        if (this.disposed) return
        await fs.writeFile(extrasPath, JSON.stringify(extras), 'utf8')
        await fs.writeFile(this.markerPath, JSON.stringify({ version: 1, fingerprint: bundle.fingerprint, installedAt: new Date().toISOString() }, null, 2), 'utf8')
        observer.stop('complete')
        this.update({ phase: 'ready', installed: true, progress: undefined, message: '环境安装完成。点击启动即可使用。', error: undefined })
      } catch (error) {
        observer.stop(this.disposed ? 'cancelled' : 'failed')
        throw error
      } finally {
        observer.stop('cancelled')
        if (this.installObserver === observer) this.installObserver = null
      }
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
      const restart = before.owned && before.phase === 'running'
      if (before.owned) {
        const stopped = await this.stop()
        if (stopped.owned || stopped.phase === 'error') return stopped
      }
      const installed = await this.install(extra)
      return installed.phase === 'ready' && restart ? await this.start() : installed
    } finally { this.extraInstallation = false }
  }

  private async verifyRuntimeComponents(extras: string[]): Promise<void> {
    const modules = [...new Set(extras.flatMap(extra => runtimeModules[extra] ?? []))]
    this.installObserver?.setStage('verifying')
    this.update({ message: '正在检查模型运行组件；首次检查 CUDA 组件可能需要 1～3 分钟，请稍候……', progress: undefined })
    // Module names come exclusively from the bundled allowlist. Importing the
    // actual packages catches missing DLLs/transitive dependencies that a mere
    // successful uv exit or find_spec would miss.
    const script = [
      'import importlib',
      `for name in ${JSON.stringify(modules)}:`,
      "    print('Amadeus checking module: ' + name, flush=True)",
      '    importlib.import_module(name)',
      ...(modules.includes('torch') ? [
        'import torch',
        'if torch.version.cuda is None:',
        "    raise RuntimeError('当前 PyTorch 是 CPU 版本，缺少默认 CUDA 加载所需组件。请重新安装该模型运行组件。')",
        'if torch.cuda.is_available():',
        "    print('Amadeus checking CUDA operation', flush=True)",
        "    value = torch.ones((2, 2), device='cuda').sum().item()",
        "    print('CUDA 实际运算检查通过：' + torch.cuda.get_device_name(0))",
        'else:',
        "    print('CUDA 运行组件已安装；本机未检测到可用 NVIDIA GPU，需要在识别设置中显式选择 CPU。')",
      ] : []),
      "print('Amadeus runtime components ready')",
    ].join('\n')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.pythonPath, ['-c', script], { cwd: this.appPath, env: this.environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      this.installer = child
      const errors: string[] = []
      this.capture(child, line => {
        const module = line.match(/^Amadeus checking module: ([a-z_]+)$/)?.[1]
        if (module) this.update({ message: `正在检查运行组件 ${module}；首次检查可能需要 1～3 分钟……`, progress: undefined })
        if (line === 'Amadeus checking CUDA operation') this.update({ message: '正在验证显卡能否执行 CUDA 运算……', progress: undefined })
        errors.push(line.trim())
        if (errors.length > 5) errors.shift()
      })
      const timeout = setTimeout(() => {
        void this.terminateOwned(child).then(() => reject(new Error('运行组件检查超时，请打开日志后重新安装该模型的运行组件。')))
      }, 180_000)
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        if (this.installer === child) this.installer = null
        error ? reject(error) : resolve()
      }
      child.once('error', error => finish(new Error(`无法检查运行组件：${error.message}`)))
      child.once('close', code => finish(code === 0 ? undefined : new Error(`运行组件安装后仍无法加载：${errors.join(' ').slice(-600) || '请打开日志查看原因。'}`)))
    })
  }

  start(): Promise<LocalRuntimeState> {
    return this.mutate(async () => {
      if (this.child && this.state.phase === 'running') return
      if (!this.state.installed || !await exists(this.pythonPath)) throw new Error('请先点击“安装本机环境”，完成后再启动。')
      if (this.child) await this.stopChild()
      this.update({ phase: 'starting', progress: undefined, installProgress: undefined, message: '正在启动本机后端……', error: undefined, url: null })
      const port = await findRuntimePort()
      const url = `http://127.0.0.1:${port}`
      const env = { ...this.environment(), PROJECT_ROOT: this.state.root, MODELS_DIR: path.join(this.state.root, 'models'),
        DEFAULT_QWEN3ASR_DEVICE: 'cuda:0', QWEN3ASR_TORCH_DTYPE: 'auto',
        DEFAULT_FORMALASR_DEVICE: 'cuda:0', FORMALASR_TORCH_DTYPE: 'auto',
        CODEX_RUNTIME_DIR: path.join(this.state.root, 'codex'), PRELOAD_DEFAULT_ENGINE: 'false', CELERY_TASK_ALWAYS_EAGER: 'true', APP_ENV: 'production',
        ...(this.options.storagePaths ? managedRuntimeEnvironment(this.options.storagePaths) : {}) }
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
    this.installObserver?.stop('cancelled')
    await this.ready
    if (this.installer) await this.terminateOwned(this.installer)
    await this.stopChild()
    await this.queue
    await this.logQueue
  }
}
