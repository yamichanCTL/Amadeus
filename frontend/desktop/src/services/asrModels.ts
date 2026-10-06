import type { ModelInfo } from './api'
import { DEFAULT_SETTINGS, type AsrModelConfig } from '@/store/useASRStore'

export type AsrModelMode = 'offline' | 'streaming'
export const ASR_ENGINE_LABELS: Record<string, string> = {
  fireredasr2: 'FireRedASR2', sensevoice: 'SenseVoice', qwen3asr: 'Qwen3-ASR',
  formalasr: 'FormalASR · 中文口语整理', whisper: 'Whisper', 'x-asr': 'X-ASR',
}

export function getAsrModelModes(model: ModelInfo): AsrModelMode[] {
  const advertised = Array.isArray(model.extra?.model_modes)
    ? model.extra.model_modes.filter((mode): mode is AsrModelMode => mode === 'offline' || mode === 'streaming') : []
  if (advertised.length) return Array.from(new Set(advertised))
  return model.extra?.supports_streaming === true ? ['streaming'] : ['offline']
}

export function fallbackAsrConfig(engine: string, model?: ModelInfo): AsrModelConfig {
  return DEFAULT_SETTINGS.asrModelConfigs[engine] || {
    modelName: model?.model_name || engine, device: model?.device || 'cuda',
    computeType: model?.compute_type || '', extraJson: '{}',
  }
}

/** Both the quick selector and advanced settings use the same saved load parameters. */
export function asrLoadPayload(engine: string, config: AsrModelConfig) {
  let extra: Record<string, unknown> = {}
  try { extra = config.extraJson.trim() ? JSON.parse(config.extraJson) as Record<string, unknown> : {} }
  catch { throw new Error(`${engine} 的参数 JSON 无效，请在识别配置中修正。`) }
  if (!extra || Array.isArray(extra) || typeof extra !== 'object') throw new Error(`${engine} 的参数 JSON 必须是对象。`)
  return {
    model_name: config.modelName,
    ...(config.device ? { device: config.device } : {}),
    ...(config.computeType && config.computeType !== 'auto' ? { compute_type: config.computeType } : {}), extra,
  }
}
