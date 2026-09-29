// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyseSpeechWindow, observeAudioElement, ScheduledAudioMouth } from './avatarAudio'
import type { LiveAvatarAudioFrame } from './liveVoiceTypes'

function tone(seconds = 0.1, amplitude = 0.2, frequency = 450) {
  return Float32Array.from({ length: Math.round(seconds * 24000) }, (_, i) => amplitude * Math.sin(i * 2 * Math.PI * frequency / 24000))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('speaker-clock mouth animation', () => {
  it('stays closed through prebuffer, follows audible output rather than decoding, and closes in a queued silent gap', () => {
    let audible = 0
    const context = { state: 'running', currentTime: 1, getOutputTimestamp: () => ({ contextTime: audible }) } as AudioContext
    const frames: LiveAvatarAudioFrame[] = []
    const mouth = new ScheduledAudioMouth(context, (frame) => frames.push(frame))
    // Device output is behind AudioContext rendering. Both packets are already decoded.
    mouth.enqueue(tone(), 24000, 0.18)
    mouth.enqueue(new Float32Array(2400), 24000, 0.28)
    audible = 0.1
    vi.advanceTimersByTime(40)
    expect(frames.at(-1)?.active).toBe(false)
    audible = 0.22
    vi.advanceTimersByTime(40)
    expect(frames.at(-1)?.level).toBeGreaterThan(0.2)
    audible = 0.32
    vi.advanceTimersByTime(40)
    expect(frames.at(-1)?.vowels).toEqual({ a: 0, i: 0, u: 0, e: 0, o: 0 })
    audible = 0.4
    vi.advanceTimersByTime(40)
    expect(vi.getTimerCount()).toBe(0)
    mouth.close()
  })

  it('cancellation closes immediately and discarded queued audio cannot reopen the mouth', () => {
    const context = { currentTime: 0, state: 'running' } as AudioContext
    const listener = vi.fn()
    const mouth = new ScheduledAudioMouth(context, listener)
    mouth.enqueue(tone(1), 24000, 0)
    expect(listener.mock.lastCall?.[0].active).toBe(true)
    mouth.stop()
    expect(listener.mock.lastCall?.[0]).toMatchObject({ level: 0, active: false, epoch: 1 })
    const count = listener.mock.calls.length
    vi.advanceTimersByTime(2000)
    expect(listener).toHaveBeenCalledTimes(count)
    mouth.enqueue(tone(), 24000, 0)
    expect(listener.mock.lastCall?.[0]).toMatchObject({ active: true, epoch: 1 })
    mouth.close()
    mouth.enqueue(tone(), 24000, 0)
    vi.advanceTimersByTime(2000)
    expect(listener.mock.lastCall?.[0].active).toBe(false)
  })

  it('does not animate audio while its AudioContext is suspended', () => {
    const context = { currentTime: 0.02, state: 'suspended' } as AudioContext
    const listener = vi.fn()
    const mouth = new ScheduledAudioMouth(context, listener)
    mouth.enqueue(tone(), 24000, 0)
    expect(listener.mock.lastCall?.[0].active).toBe(false)
    mouth.close()
  })

  it('keeps estimates bounded and distinguishes coarse spectral balance without claiming phonemes', () => {
    expect(analyseSpeechWindow(new Float32Array(500), 24000).active).toBe(false)
    expect(analyseSpeechWindow(new Float32Array(500).fill(0.9), 24000).active).toBe(false)
    const low = analyseSpeechWindow(tone(0.02, 0.2, 450), 24000)
    const high = analyseSpeechWindow(tone(0.02, 0.2, 2600), 24000)
    expect(low.vowels.o).toBeGreaterThan(high.vowels.o)
    expect(high.vowels.i).toBeGreaterThan(low.vowels.i)
    for (const result of [low, high, analyseSpeechWindow(tone(0.02, 2), 24000)]) {
      for (const weight of [result.level, ...Object.values(result.vowels)]) {
        expect(weight).toBeGreaterThanOrEqual(0)
        expect(weight).toBeLessThanOrEqual(1)
      }
      expect(Object.values(result.vowels).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(1)
    }
  })
})

describe('HTML and WebRTC output observation', () => {
  it('only emits active frames during actual playback and disposes all listeners', () => {
    const disconnect = vi.fn()
    const mediaElementSource = vi.fn(() => ({ connect: vi.fn(), disconnect }))
    class Context {
      state = 'running'
      sampleRate = 24000
      destination = {}
      resume = vi.fn(async () => undefined)
      close = vi.fn(async () => undefined)
      createMediaElementSource = mediaElementSource
      createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect } }
      createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0, connect: vi.fn(), disconnect,
        getFloatTimeDomainData: (samples: Float32Array) => samples.set(tone(samples.length / 24000)) } }
    }
    vi.stubGlobal('AudioContext', Context)
    const audio = document.createElement('audio')
    let paused = true
    Object.defineProperty(audio, 'paused', { get: () => paused })
    const listener = vi.fn()
    const dispose = observeAudioElement(audio, listener)
    expect(listener.mock.lastCall?.[0].active).toBe(false)
    paused = false
    audio.dispatchEvent(new Event('playing'))
    expect(listener.mock.lastCall?.[0].active).toBe(true)
    audio.dispatchEvent(new Event('waiting'))
    expect(listener.mock.lastCall?.[0].active).toBe(false)
    audio.dispatchEvent(new Event('playing'))
    expect(listener.mock.lastCall?.[0].active).toBe(true)
    paused = true
    audio.dispatchEvent(new Event('pause'))
    expect(listener.mock.lastCall?.[0].active).toBe(false)
    dispose()
    const count = listener.mock.calls.length
    paused = false
    audio.dispatchEvent(new Event('playing'))
    vi.advanceTimersByTime(1000)
    expect(listener).toHaveBeenCalledTimes(count)
    expect(mediaElementSource).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledTimes(3)
  })
})
