import { DEFAULT_SETTINGS, type Settings } from '@/store/useASRStore'
import type { StorageState } from './storageTypes'

const canonical = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const within = (root: string, value: unknown) => typeof value === 'string' && Boolean(root) && (canonical(value) === canonical(root) || canonical(value).startsWith(`${canonical(root)}/`))

/** Forget only references to a retired managed location; never rewrite external paths. */
export function settingsAfterStorageChange(settings: Settings, previous: StorageState, next: StorageState): Partial<Settings> {
  const changedRoot = canonical(previous.root) !== canonical(next.root)
  const removedRoot = next.cleanup?.status === 'completed' ? next.cleanup.path : undefined
  const retired = [changedRoot ? previous.root : '', removedRoot || ''].filter(Boolean)
  if (!retired.length) return {}
  const patch: Partial<Settings> = {}
  let changedModels = false
  const configs = Object.fromEntries(Object.entries(settings.asrModelConfigs).map(([engine, config]) => {
    let nextConfig = config
    try {
      const extra = JSON.parse(config.extraJson || '{}')
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        let edited = false
        for (const key of ['model_dir', 'vad_model_dir']) {
          if (retired.some(root => within(root, extra[key]))) { delete extra[key]; edited = true }
        }
        if (edited) nextConfig = { ...nextConfig, extraJson: JSON.stringify(extra) }
      }
    } catch { /* A user's unfinished advanced JSON is never discarded. */ }
    if (retired.some(root => within(root, config.modelName)) && DEFAULT_SETTINGS.asrModelConfigs[engine]) nextConfig = { ...nextConfig, modelName: DEFAULT_SETTINGS.asrModelConfigs[engine].modelName }
    changedModels ||= nextConfig !== config
    return [engine, nextConfig]
  }))
  if (changedModels) patch.asrModelConfigs = configs
  if (retired.some(root => within(root, settings.archiveDir)) || changedRoot && within(previous.archiveRoot, settings.archiveDir)) patch.archiveDir = ''
  return patch
}
