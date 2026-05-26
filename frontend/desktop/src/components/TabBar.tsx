export function TabBar<T extends string>({ value, items, onChange }: { value: T; items: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="tabbar">
      {items.map((item) => (
        <button key={item.value} type="button" className={value === item.value ? 'active' : ''} onClick={() => onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  )
}
