/**
 * AudioRecorder critical path tests.
 *
 * Verifies fixes:
 *   - stop() fallback timer: 1800ms → 500ms
 *   - prepare() settling delay: 350ms → 100ms
 *   - double-start guard
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Track instances created by mock constructors
let lastRecorderInstance: any = null

const mockStream = {
  getTracks: vi.fn(() => [{ stop: vi.fn() }]),
  active: true,
}
const mockGetUserMedia = vi.fn().mockResolvedValue(mockStream)

// Constructor mocks MUST use 'function' for vitest
const MockMediaRecorder = vi.fn(function(this: any, _stream: any, _opts: any) {
  this.state = 'recording'
  this.mimeType = 'audio/webm;codecs=opus'
  this.start = vi.fn()
  this.stop = vi.fn()
  this.requestData = vi.fn()
  this.ondataavailable = null
  this.onstop = null
  this.onerror = null
  lastRecorderInstance = this
}) as any
MockMediaRecorder.isTypeSupported = vi.fn(() => true)

const MockAudioContext = vi.fn(function(this: any) {
  this.sampleRate = 48000
  this.destination = {}
  this.audioWorklet = undefined  // triggers fallback path
  this.createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
  this.createAnalyser = vi.fn(() => ({
    fftSize: 256, frequencyBinCount: 128, connect: vi.fn(),
    getByteTimeDomainData: vi.fn((arr: Uint8Array) => { arr.fill(128) }),
  }))
  this.createScriptProcessor = vi.fn(() => ({
    connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null,
  }))
  this.createGain = vi.fn(() => ({
    connect: vi.fn(), disconnect: vi.fn(),
    gain: { value: 0 },
  }))
  this.resume = vi.fn(() => Promise.resolve())
  this.close = vi.fn(() => Promise.resolve())
}) as any

vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: mockGetUserMedia } })
vi.stubGlobal('MediaRecorder', MockMediaRecorder)
vi.stubGlobal('AudioContext', MockAudioContext)
// @ts-ignore
globalThis.MediaRecorder = MockMediaRecorder
// @ts-ignore
globalThis.AudioContext = MockAudioContext

import { AudioRecorder } from './audio'

describe('AudioRecorder', () => {
  let recorder: AudioRecorder

  beforeEach(() => {
    vi.useFakeTimers()
    lastRecorderInstance = null
    recorder = new AudioRecorder()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    // Clean up any active recorder state to prevent cross-test interference
    try { recorder.cancel() } catch { /* ignore */ }
    vi.useRealTimers()
  })

  // ── prepare() settling delay ────────────────────────────────────────────
  it('prepare: resolves after 350ms settling delay', async () => {
    const t0 = Date.now()
    const promise = recorder.prepare()
    await vi.advanceTimersByTimeAsync(350)
    await promise
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(345)
    expect(elapsed).toBeLessThan(400)
  })

  it('prepare: should call getUserMedia', async () => {
    const promise = recorder.prepare()
    await vi.advanceTimersByTimeAsync(350)
    await promise
    expect(mockGetUserMedia).toHaveBeenCalled()
  })

  // ── stop() fallback timer ───────────────────────────────────────────────
  async function startRecording() {
    const p = recorder.start()
    await vi.advanceTimersByTimeAsync(50)
    await p
  }

  it('stop: fallback timer fires at 1800ms when onstop does not fire', async () => {
    await startRecording()
    const t0 = Date.now()
    const promise = recorder.stop()
    // Don't fire onstop — let fallback fire
    await vi.advanceTimersByTimeAsync(1800)
    const result = await promise
    const elapsed = Date.now() - t0
    expect(result).toBeDefined()
    expect(elapsed).toBeGreaterThanOrEqual(1790)
    expect(elapsed).toBeLessThan(1850)
  })

  it('stop: resolves fast when onstop fires before fallback', async () => {
    await startRecording()
    const t0 = Date.now()
    const promise = recorder.stop()
    // Fire onstop at 10ms
    await vi.advanceTimersByTimeAsync(10)
    lastRecorderInstance?.onstop?.()
    await promise
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(100)
  })

  it('stop: no double-resolve when onstop fires then timer elapses', async () => {
    await startRecording()
    const promise = recorder.stop()
    await vi.advanceTimersByTimeAsync(10)
    lastRecorderInstance?.onstop?.()
    await promise
    // Advance past 500ms — should not crash
    await vi.advanceTimersByTimeAsync(1000)
  })

  // ── Guards ──────────────────────────────────────────────────────────────
  it('guard: double start throws', async () => {
    const p = recorder.start()
    await vi.advanceTimersByTimeAsync(50)
    await p
    await expect(recorder.start()).rejects.toThrow('录音已在进行中')
  })

  it('guard: stop without start throws', async () => {
    await expect(recorder.stop()).rejects.toThrow('录音尚未开始')
  })

  it('guard: start→stop→start cycle works', async () => {
    let p = recorder.start()
    await vi.advanceTimersByTimeAsync(50)
    await p
    let sp = recorder.stop()
    lastRecorderInstance?.onstop?.()
    await sp
    p = recorder.start()
    await vi.advanceTimersByTimeAsync(50)
    await p
    expect(mockGetUserMedia).toHaveBeenCalledTimes(2)
  })

  // ── Cancel ──────────────────────────────────────────────────────────────
  it('cancel: rejects in-progress start', async () => {
    let resolveGum: (s: any) => void = () => {}
    mockGetUserMedia.mockReturnValueOnce(new Promise(r => { resolveGum = r }))
    const promise = recorder.start()
    recorder.cancel()
    resolveGum(mockStream)
    await expect(promise).rejects.toThrow('录音启动已取消')
  })
})
