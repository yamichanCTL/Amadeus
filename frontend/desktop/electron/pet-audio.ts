/** Small, bounded audio-animation messages; no PCM or credentials cross this IPC. */
export type PetAudioFrame = {
  timestamp: number
  epoch: number
  audioTime: number
  level: number
  vowels: { a: number; i: number; u: number; e: number; o: number }
  active: boolean
}

export function sanitizePetAudioFrame(raw: unknown, now = Date.now()): PetAudioFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!number(value.timestamp) || Math.abs(now - value.timestamp) > 2000
    || !number(value.epoch) || !Number.isSafeInteger(value.epoch) || value.epoch < 0
    || !number(value.audioTime) || value.audioTime < 0 || !number(value.level)
    || typeof value.active !== 'boolean' || !value.vowels || typeof value.vowels !== 'object') return null
  const incoming = value.vowels as Record<string, unknown>
  const vowels = { a: 0, i: 0, u: 0, e: 0, o: 0 }
  for (const key of Object.keys(vowels) as (keyof typeof vowels)[]) {
    if (!number(incoming[key])) return null
    vowels[key] = value.active ? Math.max(0, Math.min(1, incoming[key] as number)) : 0
  }
  const sum = Object.values(vowels).reduce((a, b) => a + b, 0)
  if (sum > 1) for (const key of Object.keys(vowels) as (keyof typeof vowels)[]) vowels[key] /= sum
  return { timestamp: value.timestamp, epoch: value.epoch, audioTime: value.audioTime,
    level: value.active ? Math.max(0, Math.min(1, value.level)) : 0, active: value.active, vowels }
}
