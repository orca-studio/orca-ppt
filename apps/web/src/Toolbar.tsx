import { useEffect, useState } from 'react'
import { applyTheme, nextTheme, readTheme, THEME_LABEL, type ThemeSource } from './theme.js'

/**
 * 顶栏。全局动作都在这儿 —— 在这之前整个应用一个全局动作都没有,三个栏头只是三个标签,
 * 所以它读起来像个调试面板而不是工作台。
 *
 * 标题栏是藏起来的(macOS hiddenInset),这条同时是窗口的拖动区。
 */
export interface ToolbarProps {
  title: string | undefined
  canPresent: boolean
  /** agent 最近一次调 MCP 工具的时刻,没有就是从没调过。 */
  agentSeenAt: number | undefined
  onOpen: () => void
  onPresent: () => void
}

export function Toolbar({ title, canPresent, agentSeenAt, onOpen, onPresent }: ToolbarProps) {
  const live = useAgentLive(agentSeenAt)
  const [theme, setTheme] = useState<ThemeSource>(readTheme)

  return (
    <header className="toolbar">
      <span className="toolbar-title">{title ?? 'orca-ppt'}</span>

      <div className="toolbar-actions">
        <button
          type="button"
          className="toolbar-play"
          onClick={onPresent}
          disabled={!canPresent}
          title={canPresent ? '全屏放映(Esc 退出)' : '成品还没出来'}
        >
          ▶ 播放
        </button>
        <button type="button" onClick={onOpen}>
          打开…
        </button>
        <button
          type="button"
          title={`主题:${THEME_LABEL[theme]}`}
          onClick={() => {
            const next = nextTheme(theme)
            applyTheme(next)
            setTheme(next)
          }}
        >
          {THEME_LABEL[theme]}
        </button>
      </div>

      <span className="toolbar-agent" data-live={live}>
        {live ? 'agent 在线' : 'agent 未连'}
      </span>
    </header>
  )
}

/**
 * agent「在线」的判定:最近 60 秒内调过工具。
 *
 * MCP 是无状态 HTTP,没有连接可言 —— 唯一诚实的信号就是「它刚刚动过」。
 * 不这么判的话只能不管三七二十一都提示「还没连上?」,那是猜。
 */
const LIVE_MS = 60_000

function useAgentLive(seenAt: number | undefined): boolean {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!seenAt) return
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [seenAt])

  return Boolean(seenAt && now - seenAt < LIVE_MS)
}
