import { useEffect, useState } from 'react'
import type { PromptCard } from '@/store/useASRStore'
import './PromptTemplatePicker.css'

type Props = {
  cards: PromptCard[]
  activeCardId: string
  autoProcessing: boolean
  textModelName: string
  textModelReady: boolean
  disabled?: boolean
  hidden?: boolean
  onChange: (value: { cards: PromptCard[]; activeCardId: string; prompt: string }) => void
  onAutoProcessingChange: (enabled: boolean) => void
  onConfigureModel: () => void
}

/** Template selection only updates the ASR prompt. It never enables model calls. */
export function PromptTemplatePicker({ cards, activeCardId, autoProcessing, textModelName, textModelReady, disabled = false, hidden = false, onChange, onAutoProcessingChange, onConfigureModel }: Props) {
  const activeCard = cards.find((card) => card.id === activeCardId) || cards[0]
  const [draft, setDraft] = useState(() => ({ name: activeCard?.name || '', prompt: activeCard?.prompt || '' }))
  useEffect(() => {
    setDraft({ name: activeCard?.name || '', prompt: activeCard?.prompt || '' })
  }, [activeCard?.id])

  const select = (card: PromptCard) => onChange({ cards, activeCardId: card.id, prompt: card.prompt })
  const save = () => {
    if (!activeCard || disabled) return
    const name = draft.name.trim() || '未命名模板'
    const prompt = draft.prompt.trim()
    onChange({ cards: cards.map((card) => card.id === activeCard.id ? { ...card, name, prompt } : card), activeCardId: activeCard.id, prompt })
    setDraft({ name, prompt })
  }
  const add = () => {
    if (disabled) return
    const card = { id: `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: `自定义 ${cards.length + 1}`, prompt: '' }
    onChange({ cards: [...cards, card], activeCardId: card.id, prompt: '' })
  }
  const remove = () => {
    if (!activeCard || cards.length <= 1 || disabled) return
    const next = cards.filter((card) => card.id !== activeCard.id)
    onChange({ cards: next, activeCardId: next[0].id, prompt: next[0].prompt })
  }

  return <section className="panel recognition-template-picker" aria-label="识别处理模板" hidden={hidden}>
    <div className="recognition-template-heading">
      <div><h2>处理模板</h2><p>语音输入、文件转写与快捷键录音共用；选择模板后可自动或手动整理。</p></div>
      <label className="recognition-template-auto"><input type="checkbox" aria-label="识别后自动使用 Prompt 处理" checked={autoProcessing} disabled={disabled} onChange={(event) => onAutoProcessingChange(event.target.checked)} /><span>自动整理</span></label>
    </div>
    <div className="recognition-template-list" role="group" aria-label="选择处理模板">
      {cards.map((card) => <button key={card.id} type="button" aria-label={`选择模板：${card.name}`} aria-pressed={activeCard?.id === card.id} disabled={disabled} title={card.prompt ? `${card.prompt.slice(0, 120)}${card.prompt.length > 120 ? '…' : ''}` : '此模板尚未填写提示词'} onClick={() => select(card)}>
        <strong>{card.name}</strong><span aria-hidden="true">{activeCard?.id === card.id ? '✓' : ''}</span>
      </button>)}
    </div>
    <div className="recognition-template-status">
      <span>{autoProcessing ? textModelReady ? `自动整理已开启 · ${textModelName}` : '自动整理已开启 · 待配置模型' : '自动整理已关闭 · 可手动处理结果'}</span>
      <button type="button" onClick={onConfigureModel}>处理模型设置 ↗</button>
    </div>
    <details className="recognition-template-editor">
      <summary>编辑当前模板</summary>
      <div className="recognition-template-form">
        <label>模板名称<input value={draft.name} maxLength={60} disabled={disabled} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /></label>
        <label>Prompt 内容<textarea rows={4} value={draft.prompt} disabled={disabled} onChange={(event) => setDraft((value) => ({ ...value, prompt: event.target.value }))} /></label>
        <div className="recognition-template-actions">
          <button type="button" className="primary" disabled={disabled || !activeCard} onClick={save}>保存修改</button>
          <button type="button" disabled={disabled} onClick={add}>＋ 新增模板</button>
          <button type="button" disabled={disabled || cards.length <= 1} onClick={remove}>删除模板</button>
        </div>
      </div>
    </details>
  </section>
}
