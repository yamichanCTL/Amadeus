export type LiveProvider = 'openai' | 'qwen' | 'gemini_live' | 'gemini_thinking' | 'higgs' | 'grok'
export type LiveVoiceState = 'connecting' | 'listening' | 'speaking' | 'working' | 'closed' | 'error'
export type LiveTranscriptItem = { role: 'user' | 'assistant'; text: string; id: string; final?: boolean }
export type LiveCapture = { level: number; seconds: number; serverSeconds?: number }
/** Audio-derived animation, not a phoneme transcript. All weights are in [0, 1]. */
export type LiveAvatarAudioFrame = {
  timestamp: number
  epoch: number
  audioTime: number
  level: number
  vowels: { a: number; i: number; u: number; e: number; o: number }
  active: boolean
}
export type LiveVoiceOptions = {
  voice?: string
  brain?: 'off' | 'qwen3.7-plus'
  reasoning?: string
  outputDeviceId?: string
}
export type LiveVoiceCallbacks = {
  onState: (state: LiveVoiceState) => void
  onTranscript: (role: 'user' | 'assistant', delta: string) => void
  onError: (message: string) => void
  onDelegate: (task: string) => Promise<string>
  /** Cumulative text for one stable turn. When supplied, replaces onTranscript. */
  onTranscriptItem?: (item: LiveTranscriptItem) => void
  /** Input level in dBFS; seconds count actual microphone samples, without padding. */
  onCapture?: (capture: LiveCapture) => void
  onTool?: (tool: { name: string; result: unknown }) => void
  /** Actual output audio only; silence and cancellation explicitly publish zero. */
  onAvatarAudioFrame?: (frame: LiveAvatarAudioFrame) => void
}
