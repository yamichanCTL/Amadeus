// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@/services/api'
import { getAsrModelModes } from './Models'

const model = (engine: string, extra: Record<string, unknown>): ModelInfo => ({
  engine,
  model_name: engine,
  is_loaded: false,
  device: null,
  compute_type: null,
  languages: [],
  extra,
})

describe('backend-driven ASR model discovery', () => {
  it('accepts a newly added backend engine without a frontend engine enum', () => {
    expect(getAsrModelModes(model('future-asr', { model_modes: ['offline'] }))).toEqual(['offline'])
  })

  it('supports engines advertised for both offline and streaming use', () => {
    expect(getAsrModelModes(model('hybrid-asr', { model_modes: ['offline', 'streaming'] })))
      .toEqual(['offline', 'streaming'])
  })
})
