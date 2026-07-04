export function fillPromptFromAsr(current: string, recognized: string) {
  const next = recognized.trim()
  if (!next) return current
  const draft = current.trimEnd()
  return draft ? `${draft}\n${next}` : next
}
