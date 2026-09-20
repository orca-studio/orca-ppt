import type { PushData } from '@orca-ppt/contracts'

/**
 * agent 活动的视图模型。
 *
 * **agent 是代替人执行的,那它做的事就该和人做的一样看得见。** 画布自己翻页、文字
 * 自己变了,人不该只能干看着猜是谁干的、改了哪儿。
 *
 * 这里只管状态,不碰 DOM —— 高亮怎么画是渲染那边的事,这样这套时序逻辑能单独测。
 */

export type Activity = PushData<'mcp.activity'>

/** 一页刚被碰过。 */
export interface Touch {
  kind: 'read' | 'write'
  at: number
}

export interface AgentActivity {
  /** 正在跑的那次调用。没有就是 agent 这会儿没动静。 */
  running?: { id: string; label: string; kind: 'read' | 'write' }
  /** 刚碰过的页:页号 → 怎么碰的。 */
  touched: ReadonlyMap<number, Touch>
  /** 最近一次动静。判断 agent 还在不在,只有这一个诚实的信号。 */
  lastAt?: number
  /** 最后一次失败。工具自己拒绝(比如那段文字改不了)也算。 */
  failed?: { label: string; error: string; at: number }
}

export const idle: AgentActivity = { touched: new Map() }

/**
 * 高亮留多久。
 *
 * 写要比读留得久:读只是「它正在看这儿」,看完就过去了;写是「这儿被改了」,人得有
 * 时间把视线移过去看清改了什么。
 */
export const READ_MS = 2_500
export const WRITE_MS = 6_000

/** 多久没动静就算 agent 不在了。MCP 是无状态 HTTP,没有连接可言。 */
export const LIVE_MS = 60_000

export function reduce(state: AgentActivity, activity: Activity): AgentActivity {
  const touched = new Map(state.touched)
  for (const slide of activity.slides) touched.set(slide, { kind: activity.kind, at: activity.at })

  const next: AgentActivity = { touched, lastAt: activity.at }

  // 失败要留着,但只留最后一次 —— 攒一串错误没人看。
  if (activity.phase === 'done' && activity.error) {
    next.failed = { label: activity.label, error: activity.error, at: activity.at }
  } else if (state.failed) {
    next.failed = state.failed
  }

  if (activity.phase === 'start') {
    next.running = { id: activity.id, label: activity.label, kind: activity.kind }
  } else if (state.running && state.running.id !== activity.id) {
    // 另一次调用的 done。手上这次还在跑,别把它抹掉。
    next.running = state.running
  }
  return next
}

/**
 * 把过期的高亮清掉。**不在 reduce 里做** —— 时间自己会走,不能等下一条推送才过期,
 * 否则 agent 一停,最后那圈高亮就永远亮着。
 */
export function prune(state: AgentActivity, now: number): AgentActivity {
  const touched = new Map<number, Touch>()
  for (const [slide, touch] of state.touched) {
    if (now - touch.at < (touch.kind === 'write' ? WRITE_MS : READ_MS)) touched.set(slide, touch)
  }
  const failed = state.failed && now - state.failed.at < WRITE_MS ? state.failed : undefined

  const unchanged =
    touched.size === state.touched.size && failed === state.failed && !expired(state, now)
  if (unchanged) return state

  const next: AgentActivity = { touched }
  if (state.lastAt !== undefined) next.lastAt = state.lastAt
  if (failed) next.failed = failed
  // 正在跑的那次:done 没回来不代表它没死。活人调一次工具不会跑上一分钟。
  if (state.running && !expired(state, now)) next.running = state.running
  return next
}

function expired(state: AgentActivity, now: number): boolean {
  return Boolean(state.running && state.lastAt !== undefined && now - state.lastAt > LIVE_MS)
}

/** agent 还在吗。最近动过就算在 —— 没有连接可查,这是唯一诚实的信号。 */
export function isLive(state: AgentActivity, now: number): boolean {
  return state.lastAt !== undefined && now - state.lastAt < LIVE_MS
}

/**
 * 状态栏上显示的一行。正在跑的优先,其次是刚失败的,都没有就不显示。
 *
 * 不显示「空闲」之类 —— 没动静时那块该是空的,常驻一行字只会变成背景噪音。
 */
export function caption(
  state: AgentActivity,
): { text: string; tone: 'busy' | 'failed' } | undefined {
  if (state.running) return { text: state.running.label, tone: 'busy' }
  if (state.failed) return { text: `${state.failed.label}:${state.failed.error}`, tone: 'failed' }
  return undefined
}
