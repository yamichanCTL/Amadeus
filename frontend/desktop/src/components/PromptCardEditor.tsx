import { useEffect, useMemo, useState } from 'react'
import type { PromptCard } from '@/store/useASRStore'

type PromptCardEditorProps = {
  title: string
  description: string
  cards: PromptCard[]
  activeCardId: string
  onChange: (value: { cards: PromptCard[]; activeCardId: string; prompt: string }) => void
}

export function PromptCardEditor({ title, description, cards, activeCardId, onChange }: PromptCardEditorProps) {
  const activeCard = useMemo(
    () => cards.find((card) => card.id === activeCardId) || cards[0],
    [activeCardId, cards],
  )
  const [draft, setDraft] = useState(() => ({
    name: activeCard?.name || '未命名卡片',
    prompt: activeCard?.prompt || '',
  }))

  useEffect(() => {
    setDraft({ name: activeCard?.name || '未命名卡片', prompt: activeCard?.prompt || '' })
  }, [activeCard?.id])

  const select = (card: PromptCard) => onChange({ cards, activeCardId: card.id, prompt: card.prompt })
  const save = () => {
    if (!activeCard) return
    const name = draft.name.trim() || '未命名卡片'
    const prompt = draft.prompt.trim()
    onChange({
      cards: cards.map((card) => card.id === activeCard.id ? { ...card, name, prompt } : card),
      activeCardId: activeCard.id,
      prompt,
    })
    setDraft({ name, prompt })
  }
  const add = () => {
    const id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const card = { id, name: `自定义 ${cards.length + 1}`, prompt: '' }
    onChange({ cards: [...cards, card], activeCardId: id, prompt: '' })
  }
  const remove = () => {
    if (!activeCard || cards.length <= 1) return
    const next = cards.filter((card) => card.id !== activeCard.id)
    onChange({ cards: next, activeCardId: next[0].id, prompt: next[0].prompt })
  }

  return (
    <section className="prompt-card-editor">
      <div className="section-head compact">
        <div><h2>{title}</h2><p>{description}</p></div>
        <button type="button" onClick={add}>＋ 新增卡片</button>
      </div>
      <div className="prompt-card-list">
        {cards.map((card) => (
          <button type="button" key={card.id} className={card.id === activeCardId ? 'prompt-card active' : 'prompt-card'} onClick={() => select(card)}>
            <strong>{card.name}</strong>
            <small>{card.prompt || '点击后填写 Prompt'}</small>
            {card.id === activeCardId && <span>当前使用</span>}
          </button>
        ))}
      </div>
      <div className="prompt-card-form">
        <label>卡片名称<input value={draft.name} maxLength={60} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /></label>
        <label>Prompt 内容<textarea rows={5} value={draft.prompt} onChange={(event) => setDraft((value) => ({ ...value, prompt: event.target.value }))} /></label>
        <div className="prompt-card-actions">
          <button type="button" className="primary" onClick={save}>保存修改</button>
          <button type="button" disabled={cards.length <= 1} onClick={remove}>删除卡片</button>
        </div>
      </div>
    </section>
  )
}
