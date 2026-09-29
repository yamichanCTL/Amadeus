import type { LiveAvatarAudioFrame } from '../services/liveVoiceTypes'

export const MOUTH_SHAPES = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お' } as const
export type VowelWeights = Record<keyof typeof MOUTH_SHAPES, number>

const vowels = Object.keys(MOUTH_SHAPES) as (keyof VowelWeights)[]
const closed = (): VowelWeights => ({ a: 0, i: 0, u: 0, e: 0, o: 0 })
const bounded = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.min(1, value)) : 0

/** Audio owns articulation. Conversation status alone never opens the mouth. */
export class MouthController {
  private frame: LiveAvatarAudioFrame | null = null
  private weights = closed()
  private epoch = -1
  private timestamp = -1
  private sampledAt: number | null = null

  push(frame: LiveAvatarAudioFrame, now = Date.now()): boolean {
    if (!frame || !Number.isFinite(frame.timestamp) || frame.timestamp < 0
      || !Number.isSafeInteger(frame.epoch) || frame.epoch < 0
      || frame.timestamp > now + 250 || frame.timestamp < this.timestamp
      || frame.epoch < this.epoch) return false
    const cancelsSameFrame = frame.timestamp === this.timestamp && frame.epoch === this.epoch
      && this.frame?.active && !frame.active
    if (frame.timestamp === this.timestamp && frame.epoch === this.epoch && !cancelsSameFrame) return false

    const target = closed()
    for (const vowel of vowels) target[vowel] = bounded(frame.vowels?.[vowel])
    const sum = vowels.reduce((total, vowel) => total + target[vowel], 0)
    if (sum > 1) for (const vowel of vowels) target[vowel] /= sum
    const level = bounded(frame.level)
    const active = frame.active === true && level > 0
    if (frame.epoch > this.epoch || !active) this.weights = closed()
    this.epoch = frame.epoch
    this.timestamp = frame.timestamp
    this.frame = {
      timestamp: frame.timestamp, epoch: frame.epoch,
      audioTime: Number.isFinite(frame.audioTime) ? Math.max(0, frame.audioTime) : 0,
      level, active, vowels: target,
    }
    return true
  }

  /** Keep sequence watermarks, so a delayed pre-cancel packet cannot revive it. */
  clear(): void {
    this.frame = null
    this.weights = closed()
    this.sampledAt = null
  }

  sample(now = Date.now()): { weights: VowelWeights; voiced: boolean; max: number; epoch: number } {
    const elapsed = this.sampledAt === null ? 1000 / 60 : Math.max(0, Math.min(100, now - this.sampledAt))
    this.sampledAt = now
    const voiced = !!this.frame?.active && now - this.frame.timestamp <= 250
      && now >= this.frame.timestamp && Object.values(this.frame.vowels).some(value => value > 0)
    if (!voiced) {
      this.weights = closed()
    } else {
      const blend = 1 - Math.exp(-elapsed / 30)
      for (const vowel of vowels) {
        this.weights[vowel] += (this.frame!.vowels[vowel] - this.weights[vowel]) * blend
        if (this.weights[vowel] < 0.0001) this.weights[vowel] = 0
      }
    }
    return { weights: { ...this.weights }, voiced, max: Math.max(...Object.values(this.weights)), epoch: this.epoch }
  }
}
