// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageLocations } from './StorageLocations'
import type { StorageState } from '@/services/storageTypes'

afterEach(cleanup)
function mockStorage() {
  const initial: StorageState = {root:'D:\\AmadeusData',runtimeRoot:'D:\\AmadeusData\\runtime',pythonRoot:'D:\\AmadeusData\\python',modelsRoot:'D:\\AmadeusData\\models',cacheRoot:'D:\\AmadeusData\\cache',tempRoot:'D:\\AmadeusData\\tmp',backendDataRoot:'D:\\AmadeusData\\backend-data',avatarRoot:'D:\\AmadeusData\\avatars',archiveRoot:'D:\\AmadeusData\\archive',mode:'managed',ready:true,configRoot:'C:\\Users\\test\\AppData\\Amadeus',defaultRoot:'D:\\AmadeusData',legacyPaths:[{path:'C:\\old-runtime',label:'旧环境',kind:'legacy-runtime',canClear:true}],canChange:true,canClear:true,message:'所有大型数据集中在这里。'}
  const api = {storageStatus:vi.fn(async()=>initial),storageChooseDirectory:vi.fn(async()=>({...initial,cancelled:true})),storageOpenFolder:vi.fn(async()=>undefined),storageClearManagedData:vi.fn(async()=>initial)}
  Object.defineProperty(window,'electronAPI',{configurable:true,value:api})
  return {api,initial}
}
describe('managed storage controls', () => {
  it('shows root before installing and does not mutate storage on mount', async () => {
    const {api}=mockStorage(); render(<StorageLocations />)
    await screen.findByText('D:\\AmadeusData')
    expect(api.storageChooseDirectory).not.toHaveBeenCalled()
    expect(api.storageClearManagedData).not.toHaveBeenCalled()
  })
  it('targets only the explicitly selected retained location for cleanup', async () => {
    const {api}=mockStorage(); const onChanged=vi.fn(async()=>undefined)
    render(<StorageLocations onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button',{name:'清理此位置…'}))
    await waitFor(()=>expect(api.storageClearManagedData).toHaveBeenCalledWith('C:\\old-runtime'))
    await waitFor(()=>expect(onChanged).toHaveBeenCalledTimes(1))
  })
  it('blocks directory changes and deletion while the parent is installing', async () => {
    const {api}=mockStorage(); render(<StorageLocations disabled />)
    const choose=await screen.findByRole('button',{name:'选择数据位置'}) as HTMLButtonElement
    expect(choose.disabled).toBe(true); fireEvent.click(choose)
    const clear=screen.getByRole('button',{name:'清理当前数据…'}) as HTMLButtonElement
    expect(clear.disabled).toBe(true); fireEvent.click(clear)
    expect(api.storageChooseDirectory).not.toHaveBeenCalled(); expect(api.storageClearManagedData).not.toHaveBeenCalled()
  })
  it('explains that existing environments are retained rather than claiming a migration', async () => {
    const {api,initial}=mockStorage(); api.storageStatus.mockResolvedValue({...initial,mode:'legacy'})
    render(<StorageLocations />)
    expect(await screen.findByText(/选择新位置不会自动搬迁或删除旧文件/)).toBeTruthy()
  })
})
