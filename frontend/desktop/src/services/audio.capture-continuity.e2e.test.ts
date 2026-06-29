// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  getUserMedia: vi.fn(),
  workletNode: null as any,
  contexts: [] as any[],
}))

const track = {
  label: 'DJI MIC MINI',
  stop: vi.fn(),
  getSettings: vi.fn(() => ({ sampleRate: 48_000 })),
}
const stream = {
  active: true,
  getTracks: vi.fn(() => [track]),
  getAudioTracks: vi.fn(() => [track]),
}

class MockMediaRecorder {
  static isTypeSupported() { return true }
  state = 'recording'
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  start = vi.fn()
  requestData = vi.fn()
  stop = vi.fn(() => {
    this.state = 'inactive'
    queueMicrotask(() => this.onstop?.())
  })
}

class MockAudioWorkletNode {
  port = { onmessage: null as ((event: MessageEvent) => void) | null, close: vi.fn() }
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() { harness.workletNode = this }
}

class MockAudioContext {
  sampleRate = 48_000
  destination = {}
  audioWorklet = { addModule: vi.fn(async () => undefined) }
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
  createGain = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } }))
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  constructor() { harness.contexts.push(this) }
}

vi.stubGlobal('MediaRecorder', MockMediaRecorder)
vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode)
vi.stubGlobal('AudioContext', MockAudioContext)
vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: harness.getUserMedia } })

import { AudioRecorder } from './audio'

function emitChunk(sequence: number, value: number, frames = 128) {
  const pcm = new Int16Array(frames)
  pcm.fill(value)
  harness.workletNode.port.onmessage?.({
    data: { buffer: pcm.buffer, sampleRate: 48_000, sequence, frameStart: sequence * frames },
  } as MessageEvent)
}

async function wavPcm(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  const view = new DataView(buffer)
  expect(String.fromCharCode(...new Uint8Array(buffer, 0, 4))).toBe('RIFF')
  const dataBytes = view.getUint32(40, true)
  return new Int16Array(buffer.slice(44, 44 + dataBytes))
}

describe('microphone capture continuity end to end', () => {
  beforeEach(() => {
    harness.getUserMedia.mockReset().mockResolvedValue(stream)
    harness.workletNode = null
    harness.contexts.length = 0
    track.stop.mockClear()
  })

  it('requests the selected physical microphone without browser DSP', async () => {
    const recorder = new AudioRecorder({ rejectLoopbackInput: true })
    await recorder.start('physical-mic')
    try {
      const constraints = harness.getUserMedia.mock.calls[0][0].audio
      expect(constraints.echoCancellation).toBe(false)
      expect(constraints.noiseSuppression).toBe(false)
      expect(constraints.autoGainControl).toBe(false)
    } finally {
      recorder.cancel()
    }
  })

  it('preserves the PCM timeline when one AudioWorklet render block is missing', async () => {
    const recorder = new AudioRecorder({ rejectLoopbackInput: true })
    await recorder.start('physical-mic')
    const frames = 4_096
    emitChunk(0, 1_000, frames)
    // sequence=1 is intentionally missing: current code blindly concatenates
    // chunks and shortens the WAV, which is heard as a jump/click.
    emitChunk(2, 3_000, frames)

    const result = await recorder.stop()
    const pcm = await wavPcm(result.blob)
    expect(pcm).toHaveLength(frames * 3)
    expect([...pcm.slice(0, frames)]).toEqual(new Array(frames).fill(1_000))
    expect([...pcm.slice(frames, frames * 2)]).toEqual(new Array(frames).fill(0))
    expect([...pcm.slice(frames * 2, frames * 3)]).toEqual(new Array(frames).fill(3_000))
  })

  it('keeps a 30-second capture timeline stable under repeated isolated gaps', async () => {
    const recorder = new AudioRecorder({ rejectLoopbackInput: true })
    await recorder.start('physical-mic')
    const blockFrames = 128
    const totalBlocks = 11_250 // 30 seconds at 48kHz
    const missing = new Set([2_000, 5_500, 9_000])
    const startedAt = performance.now()
    for (let sequence = 0; sequence < totalBlocks; sequence += 1) {
      if (!missing.has(sequence)) emitChunk(sequence, 2_000, blockFrames)
    }

    const result = await recorder.stop()
    const pcm = await wavPcm(result.blob)
    const elapsedMs = performance.now() - startedAt
    console.info(`[microphone continuity stress] duration=30s blocks=${totalBlocks} gaps=${missing.size} elapsed=${elapsedMs.toFixed(1)}ms`)
    expect(pcm).toHaveLength(totalBlocks * blockFrames)
    for (const sequence of missing) {
      const start = sequence * blockFrames
      expect(pcm.slice(start, start + blockFrames).every((sample) => sample === 0)).toBe(true)
      expect(pcm[start - 1]).toBe(2_000)
      expect(pcm[start + blockFrames]).toBe(2_000)
    }
    expect(elapsedMs).toBeLessThan(2_000)
  }, 5_000)

  it('resets the frame timeline between consecutive recordings', async () => {
    const recorder = new AudioRecorder({ rejectLoopbackInput: true })
    const frames = 4_096
    await recorder.start('physical-mic')
    emitChunk(100, 1_000, frames)
    emitChunk(101, 1_000, frames)
    const first = await recorder.stop()
    expect(await wavPcm(first.blob)).toHaveLength(frames * 2)

    await recorder.start('physical-mic')
    emitChunk(0, 2_000, frames)
    emitChunk(1, 2_000, frames)
    const second = await recorder.stop()
    const secondPcm = await wavPcm(second.blob)
    expect(secondPcm).toHaveLength(frames * 2)
    expect(secondPcm.every((sample) => sample === 2_000)).toBe(true)
  })
})
