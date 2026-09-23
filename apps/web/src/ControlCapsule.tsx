import type { Control } from '@orca-ppt/contracts'
import { Button } from './ui/Button.js'

/**
 * 画布底部那颗胶囊:稿子此刻归谁动。学 ego-lite —— 所有控制状态都在同一个位置、同一个形状,
 * 只换里面的内容,人只需要记住「看底部那个胶囊」。
 *
 * 以前「你接管了 · 交还给 agent」和「自动播放」挤在画布下面同一行,看不出那是一个控制状态。
 *
 * 猜出来的持有(agent 没调 take_control)不弹胶囊:它说不出这段活儿叫什么,来得也随意,
 * 弹出来只会跟着闪。那时画布上的遮罩自己带一个「接管」(见 App 里的 AgentMask)。
 */
export interface ControlCapsuleProps {
  control: Control
  /** 没有任务名时第一行写什么 —— 稿子名。 */
  fallbackTitle: string
  onTakeOver: () => void
  onStop: () => void
  onRelease: () => void
}

type Tone = 'agent' | 'waiting' | 'user' | 'stopped' | 'message'

export function ControlCapsule({
  control,
  fallbackTitle,
  onTakeOver,
  onStop,
  onRelease,
}: ControlCapsuleProps) {
  const view = describe(control)
  if (!view) return null

  return (
    <div className="capsule" data-tone={view.tone} role="status" aria-live="polite">
      <span className="capsule-icon" aria-hidden="true" />
      <div className="capsule-text">
        <strong>{control.task ?? fallbackTitle}</strong>
        <span>{view.status}</span>
      </div>
      <div className="capsule-actions">
        {view.tone === 'agent' || view.tone === 'waiting' ? (
          <>
            <Button size="sm" onClick={onTakeOver}>
              接管
            </Button>
            <Button size="sm" className="capsule-stop" onClick={onStop}>
              停止
            </Button>
          </>
        ) : view.tone === 'user' ? (
          <Button size="sm" onClick={onRelease}>
            交还给 Agent
          </Button>
        ) : (
          <Button size="sm" onClick={onRelease}>
            知道了
          </Button>
        )}
      </div>
    </div>
  )
}

function describe(control: Control): { tone: Tone; status: string } | undefined {
  if (control.holder === 'agent') {
    if (!control.explicit) return undefined
    if (control.waiting) return { tone: 'waiting', status: `等你批准:${control.waiting}` }
    return {
      tone: 'agent',
      status: control.doing ? `Agent 正在操作 · ${control.doing}` : 'Agent 正在操作',
    }
  }
  if (control.holder === 'user') {
    return control.stopped
      ? { tone: 'stopped', status: '已停止 · Agent 这一轮不会再继续' }
      : { tone: 'user', status: '你在操作 · Agent 已停下' }
  }
  if (control.message) return { tone: 'message', status: `Agent 留言:${control.message}` }
  return undefined
}
