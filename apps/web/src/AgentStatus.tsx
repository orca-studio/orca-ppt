import type { Control } from '@orca-ppt/contracts'
import { Button } from './ui/Button.js'

export function AgentStatus({
  control,
  connected,
  onTakeOver,
  onStop,
  onRelease,
}: {
  control: Control
  connected: boolean
  onTakeOver: () => void
  onStop: () => void
  onRelease: () => void
}) {
  const active = control.holder === 'agent'
  const taken = control.holder === 'user'
  const status = active
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

  return (
    <div className="status-right agent-control">
      <span
        className="agent-control-label"
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
