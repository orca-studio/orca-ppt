import { useRef, useState } from 'react'
import type { Layout } from './layout.js'
import { ViewMenu } from './ViewMenu.js'

/**
 * 顶栏。只放**动作**,而且只放主要的那个。
 *
 * 自动播放归「放映」菜单和画布底下那行(它是放映方式,不是全局动作);打开是 ⌘O,
 * 菜单里有;主题是偏好,归「显示 > 外观」;agent 状态是状态,归底部状态栏。
 * 都摆在这儿的话,唯一真正的动作(播放)就淹了。
 *
 * 标题栏是藏起来的(macOS hiddenInset),这条同时是窗口的拖动区。
 */
export interface ToolbarProps {
  title: string | undefined
  layout: Layout
  onLayoutChange: (next: Partial<Layout>) => void
  canPresent: boolean
  onPresent: () => void
}

export function Toolbar({ title, layout, onLayoutChange, canPresent, onPresent }: ToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const viewRef = useRef<HTMLDivElement>(null)

  return (
    <header className="toolbar">
      <div className="toolbar-view" ref={viewRef}>
        <button
          type="button"
          className="toolbar-nav"
          data-on={menuOpen || layout.nav !== 'off'}
          onClick={() => setMenuOpen((open) => !open)}
          title={menuOpen ? undefined : '视图'}
          aria-label="视图"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <SidebarIcon />
        </button>
        {menuOpen && (
          <ViewMenu
            layout={layout}
            containerRef={viewRef}
            onChange={(next) => {
              onLayoutChange(next)
              // 选完就关,和 Keynote 一致 —— 开着会挡住刚切出来的视图。
              setMenuOpen(false)
            }}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>

      <span className="toolbar-title">{title ?? 'orca-ppt'}</span>

      <div className="toolbar-actions">
        <button
          type="button"
          className="toolbar-play"
          onClick={onPresent}
          disabled={!canPresent}
          title={canPresent ? '全屏放映(⌥⌘P,Esc 退出)' : '成品还没出来'}
          aria-label="全屏放映"
        >
          <PlayIcon />
        </button>
      </div>
    </header>
  )
}

/** 用 SVG 不用「▶」:那个字符的字形本身偏右偏上,怎么摆都不在圆心上。 */
function PlayIcon() {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
      <path d="M1 1.2 L8 5 L1 8.8 Z" fill="currentColor" />
    </svg>
  )
}

/** 和 macOS 侧栏开关一个意思:一个方框,左边那一竖是侧栏。 */
function SidebarIcon() {
  return (
    <svg width="15" height="13" viewBox="0 0 15 13" aria-hidden="true">
      <rect
        x="0.75"
        y="0.75"
        width="13.5"
        height="11.5"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <line x1="5.4" y1="0.75" x2="5.4" y2="12.25" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
