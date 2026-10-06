import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { LocalAvatarStatus } from '../vite-env'
import { Aemeath3D } from './Aemeath3D'

const mocks = vi.hoisted(() => ({
  createRenderer: vi.fn(),
  renderers: [] as any[],
  observers: [] as any[],
  parse: vi.fn(),
}))
vi.mock('three', async original => ({
  ...await original<typeof import('three')>(),
  WebGLRenderer: class {
    setPixelRatio = vi.fn()
    setClearColor = vi.fn()
    setSize = vi.fn()
    render = vi.fn()
    dispose = vi.fn()
    forceContextLoss = vi.fn()
    constructor(public options: { canvas: HTMLCanvasElement }) {
      mocks.createRenderer(this)
      mocks.renderers.push(this)
    }
  },
}))
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { parseAsync = mocks.parse },
}))

const available: LocalAvatarStatus = { available: true, name: 'avatar.glb', size: 1024, revision: 'one' }
let api: {
  localAvatarStatus: ReturnType<typeof vi.fn>
  localAvatarRead: ReturnType<typeof vi.fn>
  localAvatarImport: ReturnType<typeof vi.fn>
  onLocalAvatarChanged: ReturnType<typeof vi.fn>
}
let subscriptions: (() => void)[]
let animationFrames: Map<number, FrameRequestCallback>
let nextFrame: number

function model() {
  const scene = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
  scene.add(mesh)
  return { scene, dispose: vi.spyOn(mesh.geometry, 'dispose') }
}

function mount() {
  return render(<><input aria-label="对话消息" /><Aemeath3D status="idle" emotion="neutral" action="idle" /></>)
}

beforeEach(() => {
  mocks.createRenderer.mockReset()
  mocks.renderers.length = 0
  mocks.observers.length = 0
  mocks.parse.mockReset().mockImplementation(async () => ({ scene: model().scene }))
  subscriptions = []
  animationFrames = new Map()
  nextFrame = 0
  api = {
    localAvatarStatus: vi.fn(async () => available),
    localAvatarRead: vi.fn(async () => new ArrayBuffer(8)),
    localAvatarImport: vi.fn(),
    onLocalAvatarChanged: vi.fn(() => {
      const unsubscribe = vi.fn()
      subscriptions.push(unsubscribe)
      return unsubscribe
    }),
  }
  window.electronAPI = api as any
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn()
    disconnect = vi.fn()
    constructor(public callback: () => void) { mocks.observers.push(this) }
  })
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    animationFrames.set(++nextFrame, callback)
    return nextFrame
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => animationFrames.delete(id)))
})
afterEach(() => {
  cleanup()
  delete window.electronAPI
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('3D avatar failure isolation', () => {
  it('keeps conversation usable after a renderer constructor failure and retries with a fresh canvas', async () => {
    mocks.createRenderer.mockImplementationOnce(() => { throw new Error('WebGL unavailable') })
    mount()
    const oldCanvas = screen.getByLabelText('本地 3D 模型')
    expect(screen.getByRole('alert').textContent).toContain('仍可继续对话')
    fireEvent.change(screen.getByRole('textbox', { name: '对话消息' }), { target: { value: '继续' } })
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('继续')
    expect(api.localAvatarRead).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重试 3D 头像' }))
    await waitFor(() => expect(screen.getByLabelText('本地 3D 模型').getAttribute('data-loaded')).toBe('true'))
    expect(screen.getByLabelText('本地 3D 模型')).not.toBe(oldCanvas)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.createRenderer).toHaveBeenCalledTimes(2)
  })

  it('releases a partially initialized renderer when initial sizing fails', () => {
    mocks.createRenderer.mockImplementationOnce(renderer => {
      renderer.setSize.mockImplementation(() => { throw new Error('GPU initialization failed') })
    })
    mount()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(mocks.renderers[0].dispose).toHaveBeenCalledTimes(1)
    expect(mocks.renderers[0].forceContextLoss).toHaveBeenCalledTimes(1)
    expect(mocks.observers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(animationFrames.size).toBe(0)
    expect(api.localAvatarRead).not.toHaveBeenCalled()
  })

  it('stops rendering and releases loaded resources if a later animation frame fails', async () => {
    const loaded = model()
    mocks.parse.mockResolvedValueOnce(loaded)
    mount()
    await waitFor(() => expect(screen.getByLabelText('本地 3D 模型').getAttribute('data-loaded')).toBe('true'))
    const renderer = mocks.renderers[0]
    renderer.render.mockImplementationOnce(() => { throw new Error('Drawing failed') })
    renderer.dispose.mockImplementationOnce(() => { throw new Error('Context already unavailable') })
    act(() => animationFrames.get(nextFrame)!(0))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(animationFrames.size).toBe(0)
    expect(subscriptions[0]).toHaveBeenCalledTimes(1)
    expect(loaded.dispose).toHaveBeenCalledTimes(1)
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1)
  })

  it('handles context loss and discards a model that finishes loading after failure', async () => {
    const late = model()
    let finish!: (value: { scene: THREE.Group }) => void
    mocks.parse.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    mount()
    await waitFor(() => expect(mocks.parse).toHaveBeenCalledTimes(1))
    const canvas = screen.getByLabelText('本地 3D 模型')
    fireEvent(canvas, new Event('webglcontextlost', { cancelable: true }))
    expect(screen.getByRole('alert')).toBeTruthy()
    await act(async () => { finish(late) })
    expect(late.dispose).toHaveBeenCalledTimes(1)
    expect(canvas.getAttribute('data-loaded')).toBe('false')
    expect(animationFrames.size).toBe(0)
    expect(screen.getByRole('button', { name: '重试 3D 头像' })).toBeTruthy()
  })

  it('contains errors from asynchronous resizing and ignores queued callbacks after disposal', async () => {
    mount()
    await waitFor(() => expect(screen.getByLabelText('本地 3D 模型').getAttribute('data-loaded')).toBe('true'))
    const renderer = mocks.renderers[0]
    renderer.setSize.mockImplementation(() => { throw new Error('Resizing failed') })
    act(() => mocks.observers[0].callback())
    expect(screen.getByRole('alert')).toBeTruthy()
    const calls = renderer.setSize.mock.calls.length
    act(() => mocks.observers[0].callback())
    expect(renderer.setSize).toHaveBeenCalledTimes(calls)
    expect(renderer.dispose).toHaveBeenCalledTimes(1)
    expect(animationFrames.size).toBe(0)
  })

  it('offers a retry after a failed local GLB load and clears the error after recovery', async () => {
    mocks.parse.mockRejectedValueOnce(new Error('GLB 数据无效'))
    mount()
    expect((await screen.findByRole('alert')).textContent).toBe('GLB 数据无效')
    expect(screen.getByRole('button', { name: '更换本地模型' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试 3D 头像' }))
    await waitFor(() => expect(screen.getByLabelText('本地 3D 模型').getAttribute('data-loaded')).toBe('true'))
    expect(mocks.parse).toHaveBeenCalledTimes(2)
    expect(mocks.renderers[0].dispose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('explains browser limitations without attempting a renderer or model read', () => {
    delete window.electronAPI
    mount()
    expect(screen.getByText('请在 Windows 桌面版中导入本地模型。')).toBeTruthy()
    expect(mocks.createRenderer).not.toHaveBeenCalled()
    expect(mocks.parse).not.toHaveBeenCalled()
    expect(screen.queryByText('正在加载本地模型……')).toBeNull()
  })

  it('offers local import when the model is unavailable and cleans up on unmount', async () => {
    api.localAvatarStatus.mockResolvedValue({ ...available, available: false, name: null, revision: null })
    const view = mount()
    await screen.findByRole('button', { name: '导入本地 GLB' })
    expect(api.localAvatarRead).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
    expect(subscriptions.every(unsubscribe => vi.mocked(unsubscribe).mock.calls.length === 1)).toBe(true)
    expect(mocks.observers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.renderers[0].dispose).toHaveBeenCalledTimes(1)
    expect(animationFrames.size).toBe(0)
  })
})
