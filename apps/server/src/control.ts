import type { Control } from '@orca-ppt/contracts'

/**
 * 稿子此刻归谁动 —— agent 通过 MCP 改,和人在界面上改,不能同时发生。
 *
 * 和 ego 一样,agent 拿着的时候画布一直盖着遮罩,人要动先点「接管」。所以宁可锁久一点:
 * 放早了,遮罩就只在 agent 每次调用前后闪一下,人看到的是「它什么时候在干活说不准」。
 *
 * 做法借自 ego-lite 浏览器:同一时刻只有一方持有;agent 明说拿起(`take_control`)、
 * 明说交还(`hand_off`);人随时能接管,接管之后 agent 收到的是一个**硬停止**,不是
 * 「稍后重试」。和 ego 不同的两处:
 *
 * - **不懂握手的 agent 也要管住。** 没调 take_control 的,它一开始调工具就当它拿着,
 *   停下 {@link GRACE_MS} 后放下。两次调用之间它在想下一步,常常一想十几二十秒 ——
 *   这段时间遮罩得还在,不然人一动手,它下一刀下去画布一重载,人改到一半的字就没了。
 *   锁久了也不会卡住人:遮罩上就是「接管」。
 * - **明说拿着的也会过期。** ego 有常驻的浏览器和覆盖层;我们的 agent 是无状态 HTTP,
 *   可能说走就走。{@link IDLE_MS} 没有任何调用就交还给人。
 *
 * 只认 MCP。agent 用它自己的写文件工具直接改 HTML 时我们看不见 —— 那一路靠的是改字时
 * 重读磁盘、旧文字对不上就拒绝(见 `deck.editText`)。
 */
export const GRACE_MS = 30_000
export const IDLE_MS = 120_000

/** 管控制权本身的工具。它们不算「agent 在干活」,也不受人接管的拦截。 */
export const CONTROL_TOOLS = new Set(['take_control', 'hand_off'])

/** 人接管之后,agent 的每个工具收到的都是这段话。措辞学 ego:说清这是硬停止。 */
export const USER_IN_CONTROL =
  'USER_IN_CONTROL:用户在界面上接管了这份稿子。这是硬停止 —— 不要重试,不要换个工具绕过去,' +
  '也不要自己调 take_control 拿回来。结束这一轮,告诉用户你停在哪一步、还剩什么没做;' +
  '等用户明确说继续,再调 take_control。'

export interface ToolCall {
  id: string
  tool: string
  phase: 'start' | 'done'
  label: string
}

export class DeckControl {
  /** 正在跑的调用:id → 人话。并发调用各自配对,不能只记一个。 */
  readonly #running = new Map<string, string>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #state: Control = { holder: 'none', explicit: false }

  constructor(
    private readonly onChange: (state: Control) => void,
    private readonly timing = { graceMs: GRACE_MS, idleMs: IDLE_MS },
  ) {}

  state(): Control {
    return this.#state
  }

  /** agent 的一次工具调用开始或结束了。 */
  observe(call: ToolCall): void {
    if (CONTROL_TOOLS.has(call.tool)) return
    // 人接管着的时候工具根本跑不起来(见 gate),这里不会有调用。
    if (this.#state.holder === 'user') return

    if (call.phase === 'start') this.#running.set(call.id, call.label)
    else this.#running.delete(call.id)
    const busy = [...this.#running.values()].at(-1)

    if (this.#state.holder === 'agent' && this.#state.explicit) {
      // 明说拿着的:每次调用都续期,label 跟着它手上的事走。
      this.#set({ ...this.#state, label: busy ?? this.#state.label })
      this.#expireAfter(this.timing.idleMs, IDLE_MESSAGE)
      return
    }

    if (busy) {
      this.#clearTimer()
      this.#set({ holder: 'agent', explicit: false, label: busy })
    } else {
      this.#expireAfter(this.timing.graceMs)
    }
  }

  take(reason: string): Control {
    this.#set({ holder: 'agent', explicit: true, label: reason })
    this.#expireAfter(this.timing.idleMs, IDLE_MESSAGE)
    return this.#state
  }

  handOff(message: string | undefined): Control {
    this.#clearTimer()
    this.#running.clear()
    this.#set({ holder: 'none', explicit: false, ...(message ? { message } : {}) })
    return this.#state
  }

  takeOver(): Control {
    this.#clearTimer()
    this.#running.clear()
    this.#set({ holder: 'user', explicit: false })
    return this.#state
  }

  release(): Control {
    this.#clearTimer()
    this.#set({ holder: 'none', explicit: false })
    return this.#state
  }

  /** 人发来的改稿子请求能不能做。不能就返回理由。 */
  blocksHuman(): string | undefined {
    if (this.#state.holder !== 'agent') return undefined
    const doing = this.#state.label ? `「${this.#state.label}」` : '操作'
    return `agent 正在${doing},等它停下再改(要马上改,先点「接管」)`
  }

  /** agent 的这个工具能不能跑。不能就返回给它的话。 */
  blocksAgent(tool: string): string | undefined {
    if (this.#state.holder !== 'user' || CONTROL_TOOLS.has(tool)) return undefined
    return USER_IN_CONTROL
  }

  close(): void {
    this.#clearTimer()
  }

  #expireAfter(ms: number, message?: string): void {
    this.#clearTimer()
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#running.clear()
      this.#set({ holder: 'none', explicit: false, ...(message ? { message } : {}) })
    }, ms)
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #set(next: Control): void {
    const prev = this.#state
    this.#state = next
    const same =
      prev.holder === next.holder &&
      prev.explicit === next.explicit &&
      prev.label === next.label &&
      prev.message === next.message
    if (!same) this.onChange(next)
  }
}

const IDLE_MESSAGE = 'agent 两分钟没有动静,稿子交还给你了'
