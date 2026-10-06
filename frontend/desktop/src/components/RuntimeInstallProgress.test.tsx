// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeInstallProgress } from './RuntimeInstallProgress'
import type { RuntimeInstallProgress as Progress } from '@/services/localRuntimeTypes'

afterEach(cleanup)
const progress = (): Progress => ({ stage:'downloading', startedAt:Date.now()-10000, updatedAt:Date.now(), lastEventAt:Date.now(), completedItems:1, observedItems:2,
  items:[{id:'python',kind:'python',name:'CPython',version:'3.12.10',status:'installed'}, {id:'torch',kind:'package',name:'torch',version:'2.6.0',status:'downloading',totalBytes:200*1024*1024,totalBytesApproximate:true,sizeSource:'uv-log'}] })

describe('honest installer progress', () => {
  it('shows named packages and approximate sizes without inventing transferred bytes', () => {
    render(<RuntimeInstallProgress value={{ ...progress(),cache:{bytes:800*1024*1024,files:100,scope:'uv-cache-and-python',sampledAt:Date.now(),partial:false} }} />)
    expect(screen.getByText('torch')).toBeTruthy()
    expect(screen.getByText('2.6.0')).toBeTruthy()
    expect(screen.getByText('约 200.0 MiB')).toBeTruthy()
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false)
    expect(screen.getByText(/不显示估算百分比/)).toBeTruthy()
    expect(screen.getByText(/不代表本次下载流量/)).toBeTruthy()
    expect(screen.queryByText(/已下载 800/)).toBeNull()
  })
  it('renders determinate bytes only when they have been reported', () => {
    const value = progress()
    value.items[1] = { ...value.items[1], downloadedBytes:50*1024*1024, bytesPerSecond:1024*1024 }
    render(<RuntimeInstallProgress value={value} />)
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe(String(50*1024*1024))
    expect(screen.getByText('已下载 50.0 MiB')).toBeTruthy()
    expect(screen.getByText('1.0 MiB/s')).toBeTruthy()
  })
  it('distinguishes unknown sizes and bounded disk measurements', () => {
    const value = progress(); delete value.items[1].totalBytes
    render(<RuntimeInstallProgress value={{...value,cache:{bytes:1024,files:1,scope:'uv-cache-and-python',sampledAt:Date.now(),partial:true}}} />)
    expect(screen.getAllByText('大小待确认').length).toBe(2)
    expect(screen.getByText('至少 1 KiB')).toBeTruthy()
  })
  it('keeps active files visible and reveals the full observed list', () => {
    const value = progress()
    value.items.push(...Array.from({length:8},(_,i)=>({id:`done${i}`,name:`component${i}`,kind:'package' as const,status:'installed' as const})))
    render(<RuntimeInstallProgress value={value} />)
    expect(screen.getByText('torch')).toBeTruthy()
    expect(screen.queryByText('component7')).toBeNull()
    fireEvent.click(screen.getByRole('button',{name:'查看全部 10 项'}))
    expect(screen.getByText('component7')).toBeTruthy()
  })
})
