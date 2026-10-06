import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { AppPage } from '@/store/useASRStore'

export type ActivityTask = { label: string; detail?: string; page?: AppPage; onStop?: () => void | Promise<void> }
export const useActivityStore = create<{
  tasks: Record<string, ActivityTask>
  setTask: (id: string, task: ActivityTask) => void
  removeTask: (id: string) => void
}>((set) => ({
  tasks: {},
  setTask: (id, task) => set((state) => ({ tasks: { ...state.tasks, [id]: task } })),
  removeTask: (id) => set((state) => {
    if (!(id in state.tasks)) return state
    const tasks = { ...state.tasks }; delete tasks[id]; return { tasks }
  }),
}))

/** Live callbacks remain current without persisting controllers or credentials. */
export function useActivityTask(id: string, task: ActivityTask | null) {
  const stopRef = useRef(task?.onStop)
  stopRef.current = task?.onStop
  const active = Boolean(task)
  const canStop = Boolean(task?.onStop)
  const label = task?.label; const detail = task?.detail; const page = task?.page
  useEffect(() => {
    const store = useActivityStore.getState()
    if (!active || !label) { store.removeTask(id); return }
    store.setTask(id, { label, detail, page, onStop: canStop ? () => stopRef.current?.() : undefined })
    return () => useActivityStore.getState().removeTask(id)
  }, [id, active, label, detail, page, canStop])
}
