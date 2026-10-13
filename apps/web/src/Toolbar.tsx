import type { ReactNode } from 'react'
import type { HistoryState } from '@orca-ppt/contracts'
import type { Layout } from './layout.js'
import { Button } from './ui/Button.js'

/** 窗口标题和视图切换，同时保留 macOS 窗口拖动区。 */
export interface ToolbarProps {
  title: string | undefined
  /** 回首页(关掉这份稿子)。 */
  onHome: () => void
  /** 紧跟在首页、页胶片后面的稿子操作(撤销、重做、指给 agent 看)。没打开稿子时不给。 */
  tools?: ReactNode
  children?: ReactNode
  layout: Layout
  onLayoutChange: (next: Partial<Layout>) => void
}

export function Toolbar({ title, layout, onLayoutChange, onHome, tools, children }: ToolbarProps) {
  return (
    <header className="toolbar">
      {/* 首页和页胶片是一组:同款圆钮挨着放,不和一段文字混排 */}
      <div className="toolbar-nav">
        <Button variant="ghost" icon onClick={onHome} title="首页" aria-label="首页">
          <HomeIcon />
        </Button>
        <Button
          variant="ghost"
          icon
          on={layout.nav}
          onClick={() => onLayoutChange({ nav: !layout.nav })}
          title={layout.nav ? '收起页胶片' : '显示页胶片'}
          aria-label="页胶片"
          aria-pressed={layout.nav}
        >
          <SidebarIcon />
        </Button>
      </div>
      {tools}

      {/* 标题居中,和 macOS 窗口标题一样;两边按钮多少变了它也不跟着挪 */}
      <span className="toolbar-title">{title ?? 'Orca PPT'}</span>
      <div className="toolbar-agent">{children}</div>
    </header>
  )
}

export interface CanvasControlsProps {
  /** 改字的撤销 / 重做。和 ⌘Z / ⇧⌘Z、agent 的 undo / redo 是同一对协议方法。 */
  history: HistoryState
  /** 摆不摆撤销 / 重做。只读样稿上不摆。 */
  showHistory: boolean
  /** agent 正拿着稿子。撤销 / 重做会改稿子,这时点不了(server 那头也会拒)。 */
  locked: boolean
  onUndo: () => void
  onRedo: () => void
  /** 进入取锚状态:点画布上一处,指给 agent 看。 */
  picking: boolean
  /** 摆不摆「指给 agent 看」。只读样稿上不摆。 */
  showPick: boolean
  canPick: boolean
  onPick: () => void
}

export function CanvasControls({
  history,
  showHistory,
  locked,
  onUndo,
  onRedo,
  picking,
  showPick,
  canPick,
  onPick,
}: CanvasControlsProps) {
  // 只读样稿上两样都不摆 —— 翻页和页码在左栏(缩略图、页码、方向键)。
  // 以前这几个钮单独占画布底下一整条,现在挪到顶栏首页旁边,高度让给画布(和 Keynote、PowerPoint 一样)
  if (!showHistory && !showPick) return null
  return (
    <div className="toolbar-tools" role="toolbar" aria-label="稿子操作">
      <div className="toolbar-nav">
        {showHistory && (
          <>
            {/* 提示里说清撤的是哪一处 —— 光写「撤销」人不敢点。 */}
            <Button
              variant="ghost"
              icon
              onClick={onUndo}
              disabled={!history.canUndo || locked}
              title={
                locked
                  ? LOCKED_TITLE
                  : history.undo
                    ? `撤销:${history.undo}(⌘Z)`
                    : '没有可以撤销的改动'
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
          </>
        )}
        {/* 指给 agent 看:开着的时候才上强调色。只读样稿上不摆 —— 指出来也没人能改。
            放映不摆按钮:在工作台里翻页本身就是在放;全屏放映走应用菜单(⌥⌘P)。 */}
        {showPick && (
          <Button
            variant="ghost"
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
        )}
      </div>
    </div>
  )
}

const LOCKED_TITLE = 'agent 正在操作,等它停下再撤销'

/** 用 SVG 不用「▶」:那个字符的字形本身偏右偏上,怎么摆都不在圆心上。 */

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
function HomeIcon() {
  return (
    <svg width="15" height="14" viewBox="0 0 15 14" aria-hidden="true">
      <path
        d="M1.5 6.6 7.5 1.4l6 5.2M3.3 5.2v7.1h3V8.9h2.4v3.4h3V5.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

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
