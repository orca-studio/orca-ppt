/**
 * 分段控件:几个互斥的档位。
 *
 * 和按钮分开长:一条底槽,选中的那一格浮起来。以前三个档位就是三个胶囊按钮,只有
 * 选中那个有底色 —— 看上去是「一个按钮加两段字」,分不出这是一组开关。
 */
export interface SegmentedProps<T extends string> {
  items: ReadonlyArray<{ key: T; label: string }>
  value: T
  onChange: (next: T) => void
  label: string
}

export function Segmented<T extends string>({ items, value, onChange, label }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={value === item.key}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
