import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranscribeResponse } from '@/services/api'
import { RecognitionTiming } from './RecognitionTiming'

afterEach(cleanup)
const result: TranscribeResponse = { task_id: 'timing', status: 'success', full_text: '测试', segments: [], engine_used: 'formalasr', confidence: null, language: 'zh', duration_sec: 46.5, elapsed_sec: 13.4 }

describe('recognition timing evidence', () => {
  it('shows client return time separately from recording duration and backend inference', () => {
    render(<RecognitionTiming result={{ ...result, timing: { asr_sec: 13.38, total_sec: 13.4, model_ready_sec: 0.1, model_generate_sec: 12.7, audio_decode_sec: 0.5, queue_wait_sec: 0.08 }, client_timing: { request_to_result_sec: 13.9 } }} />)
    expect(screen.getByText('46.5 秒')).toBeTruthy()
    expect(screen.getAllByText('13.9 秒')).toHaveLength(2)
    fireEvent.click(screen.getByText('耗时详情'))
    expect(screen.getByText('模型准备')).toBeTruthy()
    expect(screen.getByText('12.7 秒')).toBeTruthy()
    expect(screen.getByText('0.08 秒')).toBeTruthy()
    expect(screen.getByText(/不能重复相加/)).toBeTruthy()
  })

  it('does not invent missing stages or turn unavailable timings into zero seconds', () => {
    render(<RecognitionTiming result={{ ...result, elapsed_sec: null, timing: { asr_sec: 1.2, model_ready_sec: null, model_generate_sec: NaN, queue_wait_sec: '0.5', llm_sec: -1 } }} />)
    expect(screen.getAllByText('1.20 秒')).toHaveLength(2)
    expect(screen.queryByText('模型准备')).toBeNull()
    expect(screen.queryByText('模型生成')).toBeNull()
    expect(screen.queryByText('返回耗时')).toBeNull()
    expect(screen.queryByText('追加大模型处理')).toBeNull()
  })

  it('keeps old results without timing metadata uncluttered', () => {
    const { container } = render(<RecognitionTiming result={{ ...result, elapsed_sec: null }} />)
    expect(container.firstChild).toBeNull()
  })
})
