import { useEffect, useRef } from 'react'
import type { Layout, NavMode } from './layout.js'

/**
 * 顶栏那个侧栏按钮点开的视图菜单。
 *
 * 条目是我们自己的。Keynote 那份里有一半(编辑幻灯片布局、标尺、对象列表、查找替换)
 * 是直接操作编辑器的器官 —— 我们不做那个,抄过来就是摆一排按下去没意义的项。
 */
export interface ViewMenuProps {
  layout: Layout
  onChange: (next: Partial<Layout>) => void
  onClose: () => void
}

const NAV_ITEMS: Array<{ mode: NavMode; label: string; hint: string }> = [
  { mode: 'thumbs', label: '导航器', hint: '缩略图加标题' },
  { mode: 'outline', label: '大纲', hint: '只有标题,长稿子好找' },
  { mode: 'off', label: '仅幻灯片', hint: '收起左栏' },
]

export function ViewMenu({ layout, onChange, onClose }: ViewMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  // 点到别处、按 Esc 都要关掉 —— 一个关不掉的浮层比没有还烦。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // 捕获阶段:菜单是浮在别的东西上面的,别让下面的元素先吃掉这一下
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  return (
    <div className="viewmenu" ref={ref} role="menu">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.mode}
          type="button"
          role="menuitemradio"
          aria-checked={layout.nav === item.mode}
          onClick={() => onChange({ nav: item.mode })}
        >
          <span className="viewmenu-check">{layout.nav === item.mode ? '✓' : ''}</span>
          <span className="viewmenu-label">
            {item.label}
            <em>{item.hint}</em>
          </span>
        </button>
      ))}

      <hr />

      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={layout.lightTable}
        onClick={() => onChange({ lightTable: !layout.lightTable })}
      >
        <span className="viewmenu-check">{layout.lightTable ? '✓' : ''}</span>
        <span className="viewmenu-label">
          看片台
          <em>全部页面铺开,一眼看完整份</em>
        </span>
      </button>

      <hr />

      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={layout.maker}
        onClick={() => onChange({ maker: !layout.maker })}
      >
        <span className="viewmenu-check">{layout.maker ? '✓' : ''}</span>
        <span className="viewmenu-label">
          制作栏
          <em>阶段和待办</em>
        </span>
      </button>
    </div>
  )
}
