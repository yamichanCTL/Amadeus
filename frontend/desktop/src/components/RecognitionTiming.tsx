import type { TranscribeResponse } from '@/services/api'
import './RecognitionTiming.css'

function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function formatSeconds(value: number) {
  if (value > 0 && value < 0.01) return '<0.01 秒'
  return `${value.toFixed(value < 10 ? 2 : 1)} 秒`
}

export function RecognitionTiming({ result }: { result: TranscribeResponse }) {
  const timing = result.timing || {}
  const request = seconds(result.client_timing?.request_to_result_sec)
  const backend = seconds(timing.total_sec) ?? seconds(result.elapsed_sec)
  const asr = seconds(timing.asr_sec)
  const duration = seconds(result.duration_sec)
  const entries: ReadonlyArray<readonly [string, number | undefined]> = [
    ['等待识别队列', seconds(timing.queue_wait_sec)],
    ['模型准备', seconds(timing.model_ready_sec)],
    ['音频准备', seconds(timing.audio_decode_sec) ?? seconds(timing.audio_prepare_sec)],
    ['识别推理', seconds(timing.sdk_inference_sec) ?? seconds(timing.model_inference_sec)],
    ['模型生成', seconds(timing.model_generate_sec)],
    ['结果整理', seconds(timing.result_format_sec)],
    ['识别处理', asr],
    ['标点恢复', seconds(timing.punctuation_sec)],
    ['热词处理', seconds(timing.hotword_sec)],
    ['追加大模型处理', seconds(timing.llm_sec)],
    ['后端总处理', backend],
    ['请求到结果', request],
  ]
  const available = entries.filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
  if (!available.length) return null

  return <section className="recognition-timing" aria-label="本次识别耗时">
    <div className="recognition-timing-summary">
      {duration !== undefined && <span>音频 <strong>{formatSeconds(duration)}</strong></span>}
      {(request ?? backend) !== undefined && <span>{request !== undefined ? '返回耗时' : '后端处理'} <strong>{formatSeconds((request ?? backend)!)}</strong></span>}
      {asr !== undefined && <span>识别处理 <strong>{formatSeconds(asr)}</strong></span>}
      <details>
        <summary>耗时详情</summary>
        <dl>{available.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatSeconds(value)}</dd></div>)}</dl>
        <p>准备和生成属于识别处理的一部分，不能重复相加。返回耗时从提交音频开始计算，不包含录音时间。</p>
      </details>
    </div>
  </section>
}
