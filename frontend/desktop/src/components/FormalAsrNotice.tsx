import { useASRStore } from '@/store/useASRStore'

export function FormalAsrNotice() {
  const settings = useASRStore((state) => state.settings)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const additionalLlm = settings.llmAutoPolish || settings.llmAutoTranslate

  return (
    <div className="formalasr-notice" role="note" aria-label="FormalASR 输出说明">
      <p>当前录音和文件识别使用 FormalASR：中文语音直接输出整理后的书面文本，结束录音后返回结果。实时字幕仍使用所选流式模型。</p>
      <p>{additionalLlm
        ? '追加 LLM 处理已开启，识别结果还会交给其他大模型处理。若要体验 FormalASR 自身的整理效果，请关闭追加处理。'
        : '追加 LLM 处理已关闭，识别结果直接使用 FormalASR 的书面文本。'}</p>
      {additionalLlm && (
        <button type="button" onClick={() => updateSettings({ llmAutoPolish: false, llmAutoTranslate: false })}>
          关闭追加 LLM 处理
        </button>
      )}
    </div>
  )
}
