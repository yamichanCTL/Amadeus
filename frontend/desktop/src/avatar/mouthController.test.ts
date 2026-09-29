import { describe, expect, it } from 'vitest'
import type { LiveAvatarAudioFrame } from '../services/liveVoiceTypes'
import { MouthController } from './mouthController'

const frame = (overrides: Partial<LiveAvatarAudioFrame> = {}): LiveAvatarAudioFrame => ({
  timestamp: 1000, epoch: 1, audioTime: 0, level: 0.7,
  vowels: { a: 0.8, i: 0, u: 0, e: 0, o: 0 }, active: true, ...overrides,
})

describe('audio driven mouth', () => {
  it('stays closed with no audio and does not autonomously oscillate', () => {
    const controller = new MouthController()
    for (const time of [0, 16, 1000, 16000]) expect(controller.sample(time).max).toBe(0)
  })

  it('smooths actual vowel targets over 30 ms without overshoot', () => {
    const controller = new MouthController()
    controller.push(frame(), 1000)
    const first = controller.sample(1000).weights.a
    const next = controller.sample(1030).weights.a
    expect(first).toBeGreaterThan(0)
    expect(next).toBeGreaterThan(first)
    expect(next).toBeLessThan(0.8)
    expect(controller.sample(1050).weights.i).toBe(0)
  })

  it('closes immediately on cancellation, including a cancellation in the same millisecond', () => {
    const controller = new MouthController()
    controller.push(frame(), 1000)
    expect(controller.sample(1000).max).toBeGreaterThan(0)
    expect(controller.push(frame({ active: false }), 1000)).toBe(true)
    expect(controller.sample(1000).max).toBe(0)
    expect(controller.push(frame(), 1000)).toBe(false)
    expect(controller.sample(1010).max).toBe(0)
  })

  it('closes a stale audio stream after 250 ms', () => {
    const controller = new MouthController()
    controller.push(frame(), 1000)
    expect(controller.sample(1250).max).toBeGreaterThan(0)
    expect(controller.sample(1251).max).toBe(0)
    expect(controller.sample(5000).max).toBe(0)
  })

  it('rejects out of order timestamps and stale audio epochs', () => {
    const controller = new MouthController()
    controller.push(frame({ epoch: 3 }), 1000)
    expect(controller.push(frame({ timestamp: 990, epoch: 3 }), 1000)).toBe(false)
    expect(controller.push(frame({ timestamp: 1010, epoch: 2 }), 1010)).toBe(false)
    controller.push(frame({ timestamp: 1020, epoch: 4, active: false }), 1020)
    expect(controller.push(frame({ timestamp: 1030, epoch: 3 }), 1030)).toBe(false)
    expect(controller.sample(1030).max).toBe(0)
  })

  it('starts a new epoch with no leftover vowel from the old utterance', () => {
    const controller = new MouthController()
    controller.push(frame(), 1000)
    controller.sample(1000)
    controller.push(frame({ timestamp: 1020, epoch: 2, vowels: { a: 0, i: 1, u: 0, e: 0, o: 0 } }), 1020)
    const pose = controller.sample(1020)
    expect(pose.weights.a).toBe(0)
    expect(pose.weights.i).toBeGreaterThan(0)
  })

  it('bounds and normalizes malformed vowel weights and handles invalid levels safely', () => {
    const controller = new MouthController()
    controller.push(frame({ vowels: { a: 99, i: 1, u: NaN, e: -3, o: Infinity } }), 1000)
    const pose = controller.sample(1000)
    expect(pose.weights.a).toBe(pose.weights.i)
    expect(Object.values(pose.weights).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1)
    expect(pose.weights.u + pose.weights.e + pose.weights.o).toBe(0)
    controller.push(frame({ timestamp: 1010, level: NaN }), 1010)
    expect(controller.sample(1010).max).toBe(0)
  })

  it('rejects invalid timing and excessive future timestamps', () => {
    const controller = new MouthController()
    for (const invalid of [frame({ epoch: NaN }), frame({ epoch: 1.5 }), frame({ timestamp: Infinity }), frame({ timestamp: 1400 })]) {
      expect(controller.push(invalid, 1000)).toBe(false)
    }
    expect(controller.sample(1000).max).toBe(0)
  })

  it('can clear the reference while preserving anti-replay sequence watermarks', () => {
    const controller = new MouthController()
    controller.push(frame(), 1000)
    controller.sample(1000)
    controller.clear()
    expect(controller.sample(1010).max).toBe(0)
    expect(controller.push(frame(), 1010)).toBe(false)
    expect(controller.push(frame({ timestamp: 1020 }), 1020)).toBe(true)
  })
})
