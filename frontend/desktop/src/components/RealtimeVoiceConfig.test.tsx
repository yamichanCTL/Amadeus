// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeVoiceConfig, type RealtimeVoiceCatalog } from './RealtimeVoiceConfig'
import { DEFAULT_SETTINGS, DEFAULT_AGENT_PROMPT, LEGACY_AGENT_PROMPT, useASRStore } from '@/store/useASRStore'

const catalog: RealtimeVoiceCatalog = {
  providers: [
    { id: 'qwen', label: '千问 Audio 3.1', model: 'qwen-audio-3.1-realtime-plus', configured: true, available: true,
      default_voice: 'Cherry', supports_brain: true, voices: [
        { id: 'Cherry', name: '芊悦', gender: 'female' }, { id: 'Ethan', name: '晨煦', gender: 'male' },
      ] },
    { id: 'gemini_live', label: 'Gemini 3.8 Live', model: 'gemini-3.8-live', configured: true, available: true,
      default_voice: 'Aoede', supports_brain: false, voices: [{ id: 'Aoede', name: 'Aoede', gender: 'female' }] },
    { id: 'grok', label: 'Grok Voice', model: 'grok-voice-think-fast-2.0', configured: true, available: false,
      unavailable_reason: '没有免费额度，付费测试未启用', default_voice: 'eve', supports_brain: false,
      voices: [{ id: 'eve', name: 'Eve', gender: 'unknown' }] },
  ],
  config: { dashscope_workspace_id: 'workspace-existing', dashscope_region: 'cn-beijing' },
  credential_status: { DASHSCOPE_API_KEY: true }, brain_available: true,
}
let requests: { url: string; init?: RequestInit }[]
beforeEach(() => {
  requests = []
  useASRStore.setState({ settings: { ...DEFAULT_SETTINGS, backendConfirmed: true, serverUrl: 'http://backend.test',
    agentRealtimeProvider: 'qwen', agentRealtimeOptions: {} } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    return Response.json(init?.method === 'PUT' ? { saved: true } : catalog)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Realtime provider configuration', () => {
  it('groups voices, preserves each provider selection, and keeps a paid model unavailable', async () => {
    render(<RealtimeVoiceConfig disabled={false} onCatalog={vi.fn()} />)
    await screen.findByRole('option', { name: '芊悦' })
    expect(screen.getByRole('group', { name: '女声' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '男声' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('实时音色'), { target: { value: 'Ethan' } })
    fireEvent.change(screen.getByLabelText('实时语音大脑'), { target: { value: 'qwen3.7-plus' } })
    fireEvent.change(screen.getByLabelText('实时语音通道'), { target: { value: 'gemini_live' } })
    expect(screen.queryByLabelText('实时语音大脑')).toBeNull()
    fireEvent.change(screen.getByLabelText('实时语音通道'), { target: { value: 'qwen' } })
    expect((screen.getByLabelText('实时音色') as HTMLSelectElement).value).toBe('Ethan')
    expect((screen.getByLabelText('实时语音大脑') as HTMLSelectElement).value).toBe('qwen3.7-plus')
    fireEvent.change(screen.getByLabelText('实时语音通道'), { target: { value: 'grok' } })
    expect(screen.getByRole('group', { name: '性别未核实' })).toBeTruthy()
    expect(screen.getByLabelText('实时模型状态').textContent).toContain('付费测试未启用')
    expect(screen.queryByLabelText('允许付费')).toBeNull()
  })

  it('keeps credential inputs masked and transient, sends only nonblank keys, then clears them', async () => {
    render(<RealtimeVoiceConfig disabled={false} onCatalog={vi.fn()} />)
    await screen.findByRole('option', { name: '芊悦' })
    const input = screen.getByLabelText('Gemini API Key') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'test-secret-never-persist' } })
    expect(JSON.stringify(useASRStore.getState().settings)).not.toContain('test-secret-never-persist')
    expect(localStorage.getItem('asr-desktop-store')).not.toContain('test-secret-never-persist')
    fireEvent.click(screen.getByRole('button', { name: '保存实时语音配置' }))
    await screen.findByText('已保存到本机后端，密钥输入已清空。')
    expect(input.value).toBe('')
    const request = requests.find(({ init }) => init?.method === 'PUT')!
    expect(request.init?.headers).toMatchObject({ 'X-Amadeus-Config': '1' })
    const body = JSON.parse(String(request.init?.body))
    expect(body).toEqual({ GEMINI_API_KEY: 'test-secret-never-persist', DASHSCOPE_WORKSPACE_ID: 'workspace-existing', DASHSCOPE_REGION: 'cn-beijing' })
    expect(body.GROK_EVAL_ENABLED).toBeUndefined()
  })

  it('does not read or write a backend before the existing confirmation step', () => {
    useASRStore.setState({ settings: { ...useASRStore.getState().settings, backendConfirmed: false } })
    render(<RealtimeVoiceConfig disabled={false} onCatalog={vi.fn()} />)
    expect(fetch).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '保存实时语音配置' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('migrates existing voices and removes unrecognized fields from realtime options', async () => {
    const old = { settings: { ...DEFAULT_SETTINGS, agentRealtimeProvider: 'gemini_thinking',
      agentRealtimeOptions: { gemini_thinking: { voice: 'Aoede', reasoning: 'high', API_KEY: 'never-retain' },
        qwen: { voice: 'Ethan', brain: 'qwen3.7-plus' } } } }
    const migrated = await useASRStore.persist.getOptions().migrate!(old, 41) as { settings: typeof DEFAULT_SETTINGS }
    expect(migrated.settings.agentRealtimeProvider).toBe('gemini_thinking')
    expect(migrated.settings.agentRealtimeOptions.gemini_thinking).toMatchObject({ voice: 'Aoede', reasoning: 'high' })
    expect(migrated.settings.agentRealtimeOptions.qwen?.brain).toBe('qwen3.7-plus')
    expect(JSON.stringify(migrated.settings.agentRealtimeOptions)).not.toContain('never-retain')
  })

  it('locks provider and credential changes while a session is active', async () => {
    render(<RealtimeVoiceConfig disabled onCatalog={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('实时模型状态').textContent).toContain('结束当前会话'))
    expect((screen.getByLabelText('实时语音通道') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('实时音色') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('Gemini API Key') as HTMLInputElement).disabled).toBe(true)
  })

  it('offers only supported regions and preserves custom personas during migration', async () => {
    render(<RealtimeVoiceConfig disabled={false} onCatalog={vi.fn()} />)
    await screen.findByRole('option', { name: '芊悦' })
    const select = screen.getByLabelText('百炼地域') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['cn-beijing', 'ap-southeast-1'])
    for (const oldPrompt of [LEGACY_AGENT_PROMPT, LEGACY_AGENT_PROMPT.replace(/Amadeus/g, 'ASRAPP')]) {
      const migrated = await useASRStore.persist.getOptions().migrate!({ settings: { ...DEFAULT_SETTINGS, agentPrompt: oldPrompt } }, 42) as { settings: typeof DEFAULT_SETTINGS }
      expect(migrated.settings.agentPrompt).toBe(DEFAULT_AGENT_PROMPT)
    }
    const custom = '你是 ASR-chan，这是用户自定义的角色，请保持。'
    const migrated = await useASRStore.persist.getOptions().migrate!({ settings: { ...DEFAULT_SETTINGS, agentPrompt: custom } }, 42) as { settings: typeof DEFAULT_SETTINGS }
    expect(migrated.settings.agentPrompt).toBe(custom)
    expect(DEFAULT_AGENT_PROMPT).toContain('爱弥斯')
  })
})
