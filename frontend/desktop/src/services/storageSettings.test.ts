import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/store/useASRStore'
import { settingsAfterStorageChange } from './storageSettings'
import type { StorageState } from './storageTypes'
const before = { root:'D:\\AmadeusData', archiveRoot:'D:\\AmadeusData\\archive' } as StorageState
const after = { root:'E:\\AmadeusData' } as StorageState
describe('references after storage changes', () => {
  it('clears retired managed paths but preserves CUDA and external custom paths', () => {
    const settings = { ...DEFAULT_SETTINGS, archiveDir:'D:\\AmadeusData\\archive', asrModelConfigs:{
      formalasr:{modelName:'TaurenMountain/FormalASR-1.7B',device:'cuda:0',computeType:'auto',extraJson:JSON.stringify({model_dir:'d:/AmadeusData/models/FormalASR-1.7B',batch:2})},
      whisper:{modelName:'large-v3',device:'cuda',computeType:'float16',extraJson:JSON.stringify({model_dir:'D:/AmadeusData-Shared/models'})},
    } }
    const patch=settingsAfterStorageChange(settings,before,after)
    expect(patch.archiveDir).toBe('')
    expect(patch.asrModelConfigs?.formalasr.device).toBe('cuda:0')
    expect(JSON.parse(patch.asrModelConfigs!.formalasr.extraJson)).toEqual({batch:2})
    expect(patch.asrModelConfigs?.whisper).toEqual(settings.asrModelConfigs.whisper)
  })
  it('does not alter settings for a cancelled directory selection', () => {
    expect(settingsAfterStorageChange(DEFAULT_SETTINGS,before,before)).toEqual({})
  })
  it('removes references to explicitly cleared old locations even when current root is unchanged', () => {
    const settings={...DEFAULT_SETTINGS,asrModelConfigs:{formalasr:{...DEFAULT_SETTINGS.asrModelConfigs.formalasr,extraJson:'{"model_dir":"C:/old/models"}'}}}
    const next={...before,cleanup:{status:'completed' as const,path:'C:/old',message:'已清理'}}
    expect(JSON.parse(settingsAfterStorageChange(settings,before,next).asrModelConfigs!.formalasr.extraJson)).toEqual({})
    expect(settingsAfterStorageChange(settings,before,{...next,cleanup:{...next.cleanup,status:'failed'}})).toEqual({})
  })
})
