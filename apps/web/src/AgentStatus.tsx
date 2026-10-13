import type { Control } from '@orca-ppt/contracts'
import { Button } from './ui/Button.js'

/**
 * 右上角那一处状态:本地服务连没连上、agent 连没连上、它在干什么、谁拿着稿子。
 *
 * 以前左下角还有一行状态栏,只放一个「本地服务」的绿点和「刚指给 agent」的回执 ——
 * 两处都在说「这个应用和 agent 之间通不通」,分开放人得来回看。现在只剩这一处:
 * 本地服务断了优先说这个(它断了 agent 那头的状态也不可信)。
 *
 * 平常的两种状态(连上 / 没连上)只留圆点:颜色就说清了,「Agent 已连接」几个字天天
 * 挂在那儿是噪音。字留给圆点说不清的:断线原因、agent 在做什么、等谁批准、谁接管了。
 * 平常状态的字仍在,只是看不见 —— 读屏和鼠标悬停(title)还能拿到。
 */
export function AgentStatus({
  control,
  server,
  connected,
  onTakeOver,
  onStop,
  onRelease,
}: {
  control: Control
  /** 本地服务的连接说明。连着时为 undefined。 */
  server: string | undefined
  connected: boolean
  onTakeOver: () => void
  onStop: () => void
  onRelease: () => void
}) {
  const active = control.holder === 'agent'
  const taken = control.holder === 'user'
  const status = server
    ? server
    : active
      ? control.waiting
        ? `等待批准：${control.waiting}`
        : [control.task, control.doing].filter(Boolean).join(' · ') || 'Agent 正在操作'
      : taken
        ? control.stopped
          ? '任务已停止'
          : '已接管'
        : connected
          ? 'Agent 已连接'
          : 'Agent 未连接'

  const tone = server ? 'off' : active ? 'active' : connected ? 'on' : 'idle'
  const quiet = !server && !active && !taken

  return (
    <div className="agent-control" title={quiet ? status : undefined}>
      <span className="agent-control-dot" data-tone={tone} aria-hidden="true" />
      <span
        className={quiet ? 'agent-control-label visually-hidden' : 'agent-control-label'}
        role="status"
        aria-live="polite"
        title={status}
        data-active={active}
      >
        {status}
      </span>
      {active && (
        <>
          <Button size="sm" variant="ghost" onClick={onTakeOver}>
            接管
          </Button>
          <Button size="sm" variant="ghost" onClick={onStop}>
            停止
          </Button>
        </>
      )}
      {taken && (
        <Button size="sm" variant="ghost" onClick={onRelease}>
          交还给 Agent
        </Button>
      )}
    </div>
  )
}
