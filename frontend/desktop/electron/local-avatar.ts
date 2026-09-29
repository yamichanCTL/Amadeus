import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const MAX_AVATAR_BYTES = 200 * 1024 * 1024
const MAX_JSON_BYTES = 16 * 1024 * 1024
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

export interface LocalAvatarStatus {
  available: boolean
  name: string | null
  size: number
  revision: string | null
  error?: string
}

interface AvatarManifest {
  version: 1
  filename: string
  name: string
  size: number
  sha256: string
}

const emptyStatus = (): LocalAvatarStatus => ({ available: false, name: null, size: 0, revision: null })

/** Accept self-contained glTF 2.0 only: imported models cannot fetch local/remote files. */
export function validateLocalAvatar(data: Buffer): void {
  if (!Buffer.isBuffer(data)) throw new Error('模型文件数据无效，请重新导入 GLB。')
  if (data.length > MAX_AVATAR_BYTES) throw new Error('模型文件不能超过 200 MB。')
  if (data.length < 20 || data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) {
    throw new Error('文件不是完整的 GLB 2.0 模型，请从建模软件重新导出。')
  }
  let cursor = 12
  let json: Record<string, any> | null = null
  let binaryBytes: number | null = null
  while (cursor < data.length) {
    if (cursor + 8 > data.length) throw new Error('GLB 数据块不完整。')
    const length = data.readUInt32LE(cursor)
    const kind = data.readUInt32LE(cursor + 4)
    const start = cursor + 8
    if (length % 4 || start + length > data.length) throw new Error('GLB 数据块长度无效。')
    if (cursor === 12 && kind !== JSON_CHUNK) throw new Error('GLB 缺少模型描述。')
    if (kind === JSON_CHUNK) {
      if (json || length > MAX_JSON_BYTES) throw new Error('GLB 模型描述重复或过大。')
      try { json = JSON.parse(data.toString('utf8', start, start + length)) } catch { throw new Error('GLB 模型描述无法解析。') }
    } else if (kind === BIN_CHUNK) {
      if (binaryBytes !== null) throw new Error('GLB 包含重复的二进制数据块。')
      binaryBytes = length
    }
    cursor = start + length
  }
  if (!json || typeof json !== 'object' || json.asset?.version !== '2.0' || !Array.isArray(json.meshes) || !json.meshes.length) {
    throw new Error('GLB 中没有可显示的 glTF 2.0 网格模型。')
  }
  for (const name of ['buffers', 'images', 'bufferViews', 'accessors', 'nodes', 'scenes', 'animations', 'materials', 'skins', 'textures', 'samplers', 'extensionsRequired', 'extensionsUsed']) {
    if (json[name] !== undefined && !Array.isArray(json[name])) throw new Error(`GLB 的 ${name} 数据格式无效，请重新导出。`)
  }
  if (json.meshes.some((mesh: unknown) => !mesh || typeof mesh !== 'object' || !Array.isArray((mesh as { primitives?: unknown }).primitives))) {
    throw new Error('GLB 网格数据格式无效，请重新导出。')
  }
  const unsupported = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'])
  if (Array.isArray(json.extensionsRequired) && json.extensionsRequired.some((extension: unknown) => unsupported.has(String(extension)))) {
    throw new Error('当前暂不支持此压缩模型，请导出不含 Draco、Meshopt 或 KTX2 压缩的普通 GLB。')
  }
  // Walk extension objects too; URI-bearing glTF extensions must remain embedded.
  const pending: unknown[] = [json]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    for (const [key, entry] of Object.entries(value)) {
      if (key.toLowerCase() === 'uri' && (typeof entry !== 'string' || !/^data:(?:image\/(?:png|jpeg|webp|avif)|application\/(?:octet-stream|gltf-buffer));base64,[A-Za-z0-9+/=\r\n]*$/i.test(entry))) {
        throw new Error('请导出包含全部贴图和数据的 GLB；当前模型还引用了外部文件。')
      }
      if (entry && typeof entry === 'object') pending.push(entry)
    }
  }
  for (const buffer of json.buffers || []) {
    if (!buffer || typeof buffer !== 'object' || Array.isArray(buffer)) throw new Error('GLB 缓冲区数据格式无效，请重新导出。')
    if (!buffer.uri && (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || binaryBytes === null || buffer.byteLength > binaryBytes)) {
      throw new Error('GLB 的内嵌模型数据不完整。')
    }
  }
}

async function boundedRead(filename: string): Promise<Buffer> {
  const file = await fs.open(filename, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 20 || stat.size > MAX_AVATAR_BYTES) throw new Error('请选择不超过 200 MB 的完整 GLB 文件。')
    const data = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
      if (!bytesRead) throw new Error('读取期间模型文件发生变化，请重新导入。')
      offset += bytesRead
    }
    if ((await file.read(Buffer.allocUnsafe(1), 0, 1, offset)).bytesRead) throw new Error('读取期间模型文件发生变化，请重新导入。')
    return data
  } finally { await file.close() }
}

/** Owns copies only. Original user-selected files are never modified or removed. */
export class LocalAvatarStore {
  private readonly root: string
  private readonly manifestPath: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(root: string, private readonly onChange?: (status: LocalAvatarStatus) => void) {
    this.root = path.resolve(root)
    if (!path.isAbsolute(root) || this.root === path.parse(this.root).root) throw new Error('本地模型目录必须是独立的绝对路径。')
    this.manifestPath = path.join(this.root, 'avatar.json')
  }

  private async manifest(): Promise<AvatarManifest | null> {
    let data: AvatarManifest
    try { data = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('本地模型记录损坏，请重新导入 GLB。')
    }
    if (!data || typeof data !== 'object' || data.version !== 1 || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)
      || data.filename !== `${data.sha256}.glb` || typeof data.name !== 'string' || data.name.length > 512
      || !Number.isSafeInteger(data.size) || data.size < 20 || data.size > MAX_AVATAR_BYTES) {
      throw new Error('本地模型记录无效，请重新导入 GLB。')
    }
    return data
  }

  private statusOf(manifest: AvatarManifest): LocalAvatarStatus {
    return { available: true, name: manifest.name, size: manifest.size, revision: manifest.sha256 }
  }

  async status(): Promise<LocalAvatarStatus> {
    try {
      const manifest = await this.manifest()
      if (!manifest) return emptyStatus()
      const stat = await fs.lstat(path.join(this.root, manifest.filename))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.size) throw new Error('本地模型文件已丢失或发生变化，请重新导入。')
      return this.statusOf(manifest)
    } catch (error) {
      return { ...emptyStatus(), error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? '本地模型文件已丢失，请重新导入。' : error instanceof Error ? error.message : '本地模型无法读取，请重新导入。' }
    }
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work)
    this.queue = task.catch(() => undefined)
    return task
  }

  private emit(status: LocalAvatarStatus): void {
    try { this.onChange?.(status) } catch { /* A closed renderer cannot invalidate a saved import. */ }
  }

  importFile(filename: string): Promise<LocalAvatarStatus> {
    return this.mutate(async () => {
      if (!path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.glb') throw new Error('请选择本机的 .glb 模型文件。')
      const data = await boundedRead(filename)
      validateLocalAvatar(data)
      const hash = createHash('sha256').update(data).digest('hex')
      const manifest: AvatarManifest = { version: 1, filename: `${hash}.glb`, name: path.basename(filename), size: data.length, sha256: hash }
      await fs.mkdir(this.root, { recursive: true })
      const destination = path.join(this.root, manifest.filename)
      // Write the validated bytes, not a second read of a possibly changing source.
      await fs.writeFile(`${destination}.tmp`, data)
      await fs.rename(`${destination}.tmp`, destination)
      await fs.writeFile(`${this.manifestPath}.tmp`, JSON.stringify(manifest), 'utf8')
      await fs.rename(`${this.manifestPath}.tmp`, this.manifestPath)
      const status = this.statusOf(manifest)
      this.emit(status)
      return status
    })
  }

  read(): Promise<ArrayBuffer | null> {
    return this.mutate(async () => {
      const status = await this.status()
      if (!status.available) return null
      const manifest = (await this.manifest())!
      const data = await boundedRead(path.join(this.root, manifest.filename))
      if (data.length !== manifest.size || createHash('sha256').update(data).digest('hex') !== manifest.sha256) throw new Error('本地模型文件校验失败，请重新导入。')
      validateLocalAvatar(data)
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    })
  }

  clear(): Promise<LocalAvatarStatus> {
    return this.mutate(async () => {
      await fs.unlink(this.manifestPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      // Managed copies may already be loaded by both renderers. Remove only our exact
      // generated filenames; never recurse into user-selected source directories.
      const entries = await fs.readdir(this.root).catch(() => [])
      for (const entry of entries) if (/^[a-f0-9]{64}\.glb$/.test(entry)) await fs.unlink(path.join(this.root, entry)).catch(() => undefined)
      const status = emptyStatus()
      this.emit(status)
      return status
    })
  }
}
