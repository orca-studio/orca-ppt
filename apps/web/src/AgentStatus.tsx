import type { Control } from '@orca-ppt/contracts'

/**
 * 右上角那一处状态:本地服务连没连上、agent 连没连上、它在干什么、谁拿着稿子。
 *
 * 以前左下角还有一行状态栏,只放一个「本地服务」的绿点和「刚指给 agent」的回执 ——
 * 两处都在说「这个应用和 agent 之间通不通」,分开放人得来回看。现在只剩这一处:
 * 本地服务断了优先说这个(它断了 agent 那头的状态也不可信)。
 *
 * 只有圆点,不写字:连上(绿)/ 没连上(灰)/ 断线(红)/ agent 在干活(一明一暗)。
 * 本来就是 agent 驱动的 —— 它在做什么、等什么批准,人在 agent 的对话里都看得到,
 * 这里再写一遍作用有限;画布和页胶片上它碰到哪儿亮哪儿,也比一行字清楚。
 * 那句话仍在,读屏和鼠标悬停(title)还能拿到。
 *
 * 以前圆点旁边还有「接管 / 停止 / 交还给 Agent」三个按钮,2026-11-09 去掉了:
 * 工作台常放在 AI 助手的侧边栏里,停止用对话框自己的停止键就在旁边;接管只在「agent 正在改、
 * 人也要同时手动改」时有用,而改动本来就按稿子排队、写页带版本号、改字要先找到原文,人改过的
 * 地方 agent 改不上,不会覆盖。协议方法 control.takeOver / stop / release 还在,MCP 和 CLI 照用。
 */
export function AgentStatus({
  control,
  server,
  connected,
}: {
  control: Control
  /** 本地服务的连接说明。连着时为 undefined。 */
  server: string | undefined
  connected: boolean
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

  return (
    <div className="agent-control" title={status} data-ui-target="control.capsule">
      <span className="agent-control-dot" data-tone={tone} aria-hidden="true" />
      <span className="visually-hidden" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  )
}
