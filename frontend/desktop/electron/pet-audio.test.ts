import { describe, expect, it } from 'vitest'
import { sanitizePetAudioFrame } from './pet-audio'

const sample = { timestamp: 1000, epoch: 7, audioTime: 2, active: true,
  level: .5, vowels: { a: .4, i: .1, u: .1, e: .1, o: .1 } }

describe('desktop pet audio IPC boundary', () => {
  it('allows a current complete frame and preserves the playback time', () => {
    expect(sanitizePetAudioFrame(sample, 1000)).toEqual(sample)
  })
  it('rejects malformed, future and nonfinite values', () => {
    for (const bad of [null, { ...sample, epoch: NaN }, { ...sample, timestamp: 6000 },
      { ...sample, vowels: { ...sample.vowels, a: Infinity } }, { ...sample, audioTime: -1 }]) {
      expect(sanitizePetAudioFrame(bad, 1000)).toBeNull()
    }
  })
  it('bounds mixed shapes and forces cancellation to zero', () => {
    const mixed = sanitizePetAudioFrame({ ...sample, level: 6, vowels: { a: 3, i: 3, u: -8, e: 0, o: 0 } }, 1000)!
    expect(mixed.vowels).toEqual({ a: .5, i: .5, u: 0, e: 0, o: 0 })
    expect(mixed.level).toBe(1)
    const cancelled = sanitizePetAudioFrame({ ...sample, active: false }, 1000)!
    expect(Object.values(cancelled.vowels).every(value => value === 0)).toBe(true)
    expect(cancelled.level).toBe(0)
  })
})
