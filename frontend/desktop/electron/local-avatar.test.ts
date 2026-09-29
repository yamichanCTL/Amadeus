// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { LocalAvatarStore, MAX_AVATAR_BYTES, validateLocalAvatar, type LocalAvatarStatus } from './local-avatar'

function triangle(overrides: Record<string, unknown> = {}): Buffer {
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    ...overrides,
  }))
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20)
  json.copy(padded)
  const data = Buffer.alloc(12 + 8 + padded.length + 8 + 36)
  data.writeUInt32LE(0x46546c67, 0)
  data.writeUInt32LE(2, 4)
  data.writeUInt32LE(data.length, 8)
  data.writeUInt32LE(padded.length, 12)
  data.writeUInt32LE(0x4e4f534a, 16)
  padded.copy(data, 20)
  data.writeUInt32LE(36, 20 + padded.length)
  data.writeUInt32LE(0x004e4942, 24 + padded.length)
  return data
}

let directory: string
let store: LocalAvatarStore
let source: string
let changes: LocalAvatarStatus[]

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-avatar-'))
  source = path.join(directory, '我的 本地模型.glb')
  await fs.writeFile(source, triangle())
  changes = []
  store = new LocalAvatarStore(path.join(directory, 'user data', 'avatars'), status => changes.push(status))
})

afterEach(async () => {
  const resolved = path.resolve(directory)
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('amadeus-avatar-')) throw new Error('Unsafe cleanup target')
  await fs.rm(resolved, { recursive: true, force: true })
})

describe('local-only model import', () => {
  it('starts empty, stores a copy, returns exact ArrayBuffer and survives restart', async () => {
    expect(await store.status()).toEqual({ available: false, name: null, size: 0, revision: null })
    expect(await store.read()).toBeNull()
    const expected = await fs.readFile(source)
    const imported = await store.importFile(source)
    expect(imported).toMatchObject({ available: true, name: '我的 本地模型.glb', size: expected.length, revision: createHash('sha256').update(expected).digest('hex') })
    expect(changes).toEqual([imported])
    const data = await store.read()
    expect(data).toBeInstanceOf(ArrayBuffer)
    expect(Buffer.from(data!)).toEqual(expected)
    await fs.unlink(source)
    const reopened = new LocalAvatarStore(path.join(directory, 'user data', 'avatars'))
    expect((await reopened.status()).revision).toBe(imported.revision)
    expect(Buffer.from((await reopened.read())!)).toEqual(expected)
  })

  it('keeps previous valid avatar when another file is invalid', async () => {
    const previous = await store.importFile(source)
    const invalid = path.join(directory, 'invalid.glb')
    await fs.writeFile(invalid, triangle({ images: [{ uri: 'https://external.example/private.png' }] }))
    await expect(store.importFile(invalid)).rejects.toThrow('外部文件')
    expect(await store.status()).toEqual(previous)
    expect(changes).toHaveLength(1)
  })

  it('detects modified managed bytes even if file length did not change', async () => {
    const status = await store.importFile(source)
    const managed = path.join(directory, 'user data', 'avatars', `${status.revision}.glb`)
    const corrupt = await fs.readFile(managed)
    corrupt[corrupt.length - 1] = 7
    await fs.writeFile(managed, corrupt)
    await expect(store.read()).rejects.toThrow('校验失败')
  })

  it('clears only managed copies, preserving original file and unrelated avatar folder entries', async () => {
    const original = await fs.readFile(source)
    await store.importFile(source)
    const unrelated = path.join(directory, 'user data', 'avatars', 'notes.txt')
    await fs.writeFile(unrelated, 'keep')
    expect((await store.clear()).available).toBe(false)
    expect(await fs.readFile(source)).toEqual(original)
    expect(await fs.readFile(unrelated, 'utf8')).toBe('keep')
    expect(await store.read()).toBeNull()
    expect(changes).toHaveLength(2)
  })

  it('rejects an oversized source before reading its contents', async () => {
    const large = path.join(directory, 'too-large.glb')
    const file = await fs.open(large, 'w')
    await file.truncate(MAX_AVATAR_BYTES + 1)
    await file.close()
    await expect(store.importFile(large)).rejects.toThrow('200 MB')
  })

  it('refuses manipulated manifest paths without reading files outside managed storage', async () => {
    await store.importFile(source)
    const manifest = path.join(directory, 'user data', 'avatars', 'avatar.json')
    await fs.writeFile(manifest, JSON.stringify({ version: 1, filename: '../../private.glb', name: 'private', size: 100, sha256: 'a'.repeat(64) }))
    expect(await store.status()).toMatchObject({ available: false, error: expect.stringContaining('记录无效') })
    expect(await store.read()).toBeNull()
  })
})

describe('self-contained GLB validation', () => {
  it('accepts ordinary embedded glTF 2.0 and embedded image data', () => {
    expect(() => validateLocalAvatar(triangle())).not.toThrow()
    expect(() => validateLocalAvatar(triangle({ images: [{ uri: 'data:image/png;base64,AAAA' }] }))).not.toThrow()
  })
  it.each(['https://example.com/texture.png', 'file:///C:/secret.png', '../texture.png', '//example.com/texture.png'])('rejects external URI %s', uri => {
    expect(() => validateLocalAvatar(triangle({ images: [{ uri }] }))).toThrow('外部文件')
  })
  it('rejects malformed lengths, versions and unexpected buffer shapes with useful errors', () => {
    const truncated = triangle().subarray(0, -1)
    expect(() => validateLocalAvatar(truncated)).toThrow('完整')
    const wrongVersion = triangle()
    wrongVersion.writeUInt32LE(1, 4)
    expect(() => validateLocalAvatar(wrongVersion)).toThrow('2.0')
    expect(() => validateLocalAvatar(triangle({ buffers: {} }))).toThrow('数据格式无效')
    expect(() => validateLocalAvatar(triangle({ buffers: [null] }))).toThrow('数据格式无效')
    expect(() => validateLocalAvatar(triangle({ buffers: [{ byteLength: 99999 }] }))).toThrow('数据不完整')
    expect(() => validateLocalAvatar(triangle({ extensionsRequired: ['KHR_draco_mesh_compression'] }))).toThrow('压缩')
  })
})
