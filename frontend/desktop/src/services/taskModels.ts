import type { Settings } from '@/store/useASRStore'

/** Credentials belong to a reusable connection; model selection belongs to a task. */
export type ModelConnection = {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiToken: string
}
export type LLMTask = 'asr_postprocess' | 'summary' | 'agent'
export type TaskModelBinding = { connectionId: string; model: string }
export type TaskLLMConfig = { provider: string; baseUrl: string; apiToken: string; model: string }
export const LEGACY_CONNECTION_ID = 'legacy-default'
export const LLM_TASKS: LLMTask[] = ['asr_postprocess', 'summary', 'agent']
export const TASK_MODEL_LABELS: Record<LLMTask, string> = {
  asr_postprocess: '识别后处理', summary: '总结', agent: '实时对话大脑',
}

export function legacyLLMConfig(settings: Pick<Settings, 'llmProvider' | 'llmBaseUrl' | 'llmApiToken' | 'llmModel'>): TaskLLMConfig {
  return { provider: settings.llmProvider, baseUrl: settings.llmBaseUrl, apiToken: settings.llmApiToken, model: settings.llmModel }
}

export function resolveTaskLLM(settings: Settings, task: LLMTask): TaskLLMConfig {
  const binding = settings.taskModels?.[task]
  const connection = settings.modelConnections?.find((item) => item.id === binding?.connectionId)
  // Keep old profiles and callers functional until they are first normalized.
  if (!binding) return legacyLLMConfig(settings)
  if (!connection) return { provider: 'custom', baseUrl: '', apiToken: '', model: binding.model }
  return { provider: connection.provider, baseUrl: connection.baseUrl, apiToken: connection.apiToken, model: binding.model }
}

export function normalizeTaskModels(settings: Settings, source?: Partial<Settings>): Pick<Settings, 'modelConnections' | 'taskModels'> {
  const connections = Array.isArray(source?.modelConnections)
    ? source.modelConnections.filter((item) => item && typeof item.id === 'string' && item.id.trim())
      .slice(0, 40).map((item) => ({
        id: item.id.trim().slice(0, 100),
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 100) : '未命名连接',
        provider: typeof item.provider === 'string' ? item.provider : 'custom',
        baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
        apiToken: typeof item.apiToken === 'string' ? item.apiToken : '',
      }))
    : []
  // A stable legacy connection lets older settings/imports update their original
  // connection without silently changing every task's selected model.
  const legacy = legacyLLMConfig(settings)
  const unique = new Map(connections.map((connection) => [connection.id, connection]))
  if (!unique.has(LEGACY_CONNECTION_ID)) unique.set(LEGACY_CONNECTION_ID, {
    id: LEGACY_CONNECTION_ID, name: '原有模型连接', provider: legacy.provider,
    baseUrl: legacy.baseUrl, apiToken: legacy.apiToken,
  })
  const taskModels = Object.fromEntries(LLM_TASKS.map((task) => {
    const saved = source?.taskModels?.[task]
    // Only migration uses the old global model. An intentionally empty model
    // remains empty; selecting a new connection never falls back to old keys.
    return [task, saved ? {
      connectionId: unique.has(saved.connectionId) ? saved.connectionId : '',
      model: typeof saved.model === 'string' ? saved.model : '',
    } : { connectionId: LEGACY_CONNECTION_ID, model: legacy.model }]
  })) as Record<LLMTask, TaskModelBinding>
  return { modelConnections: Array.from(unique.values()), taskModels }
}
