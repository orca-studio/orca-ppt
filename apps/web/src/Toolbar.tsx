import { useRef, useState, type ReactNode } from 'react'
import type { HistoryState } from '@orca-ppt/contracts'
import type { Layout } from './layout.js'
import { ViewMenu } from './ViewMenu.js'
import { Button } from './ui/Button.js'

/** 窗口标题和视图切换，同时保留 macOS 窗口拖动区。 */
export interface ToolbarProps {
  title: string | undefined
  children?: ReactNode
  layout: Layout
  onLayoutChange: (next: Partial<Layout>) => void
}

export function Toolbar({ title, layout, onLayoutChange, children }: ToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const viewRef = useRef<HTMLDivElement>(null)

  return (
    <header className="toolbar">
      <div className="toolbar-view" ref={viewRef}>
        <Button
          variant="ghost"
          icon
          on={menuOpen || layout.nav !== 'off'}
          onClick={() => setMenuOpen((open) => !open)}
          title={menuOpen ? undefined : '视图'}
          aria-label="视图"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <SidebarIcon />
        </Button>
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

      <span className="toolbar-title">{title ?? 'Orca PPT'}</span>
      <div className="toolbar-agent">{children}</div>
    </header>
  )
}

export interface CanvasControlsProps {
  canPresent: boolean
  onPresent: () => void
  /** 改字的撤销 / 重做。和 ⌘Z / ⇧⌘Z、agent 的 undo / redo 是同一对协议方法。 */
  history: HistoryState
  /** agent 正拿着稿子。撤销 / 重做会改稿子,这时点不了(server 那头也会拒)。 */
  locked: boolean
  onUndo: () => void
  onRedo: () => void
  /** 进入取锚状态:点画布上一处,指给 agent 看。 */
  picking: boolean
  canPick: boolean
  onPick: () => void
  slide: number
  slideCount: number
  onNavigate: (action: 'previous' | 'next') => void
}

export function CanvasControls({
  canPresent,
  onPresent,
  history,
  locked,
  onUndo,
  onRedo,
  picking,
  canPick,
  onPick,
  slide,
  slideCount,
  onNavigate,
}: CanvasControlsProps) {
  return (
    <div className="canvas-controls" role="toolbar" aria-label="画布操作">
      <div className="canvas-controls-group">
        {/* 提示里说清撤的是哪一处 —— 光写「撤销」人不敢点。 */}
        <Button
          variant="ghost"
          icon
          onClick={onUndo}
          disabled={!history.canUndo || locked}
          title={
            locked ? LOCKED_TITLE : history.undo ? `撤销:${history.undo}(⌘Z)` : '没有可以撤销的改动'
          }
          aria-label="撤销"
        >
          <UndoIcon />
        </Button>
        <Button
          variant="ghost"
          icon
          onClick={onRedo}
          disabled={!history.canRedo || locked}
          title={
            locked
              ? LOCKED_TITLE
              : history.redo
                ? `重做:${history.redo}(⇧⌘Z)`
                : '没有可以重做的改动'
          }
          aria-label="重做"
        >
          <UndoIcon flipped />
        </Button>
      </div>
      <div className="canvas-controls-pages">
        <Button
          variant="ghost"
          icon
          disabled={locked || slide === 0}
          onClick={() => onNavigate('previous')}
          aria-label="上一页"
          title="上一页"
        >
          <span aria-hidden="true">‹</span>
        </Button>
        <span className="canvas-controls-count">
          第 {slide + 1} / {slideCount} 页
        </span>
        <Button
          variant="ghost"
          icon
          disabled={locked || slide >= slideCount - 1}
          onClick={() => onNavigate('next')}
          aria-label="下一页"
          title="下一页"
        >
          <span aria-hidden="true">›</span>
        </Button>
      </div>
      <div className="canvas-controls-group canvas-controls-primary">
        {/* 指给 agent 看是次要动作:和播放一样是圆钮,开着的时候才上强调色。 */}
        <Button
          icon
          on={picking}
          aria-pressed={picking}
          onClick={onPick}
          disabled={!canPick}
          title={picking ? '点画布上的元素,Esc 取消' : '指给 agent 看:点画布上一处'}
          aria-label="指给 agent 看"
        >
          <TargetIcon />
        </Button>
        <Button
          onClick={onPresent}
          disabled={!canPresent}
          title={canPresent ? '全屏放映(⌥⌘P,Esc 退出)' : '成品还没出来'}
          aria-label="全屏放映"
        >
          <PlayIcon />
          <span>放映</span>
        </Button>
      </div>
    </div>
  )
}

const LOCKED_TITLE = 'agent 正在操作,等它停下再撤销'

/** 用 SVG 不用「▶」:那个字符的字形本身偏右偏上,怎么摆都不在圆心上。 */
function PlayIcon() {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
      <path d="M1 1.2 L8 5 L1 8.8 Z" fill="currentColor" />
    </svg>
  )
}

/** 回转箭头。重做是它的镜像。 */
function UndoIcon({ flipped = false }: { flipped?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      aria-hidden="true"
      style={flipped ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path
        d="M4.2 2.2 1.5 4.9l2.7 2.7M1.8 4.9h5.9a3.6 3.6 0 0 1 0 7.2H5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 准星:点中画布上的一处。 */
function TargetIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6.5" cy="6.5" r="1.3" fill="currentColor" />
      <line x1="6.5" y1="0" x2="6.5" y2="1.6" stroke="currentColor" strokeWidth="1.3" />
      <line x1="6.5" y1="11.4" x2="6.5" y2="13" stroke="currentColor" strokeWidth="1.3" />
      <line x1="0" y1="6.5" x2="1.6" y2="6.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="11.4" y1="6.5" x2="13" y2="6.5" stroke="currentColor" strokeWidth="1.3" />
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
