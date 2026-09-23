import type { Control } from '@orca-ppt/contracts'

/**
 * 稿子此刻归谁动 —— agent 通过 MCP 改,和人在界面上改,不能同时发生。
 *
 * 和 ego 一样,agent 拿着的时候画布一直盖着遮罩,人要动先点「接管」。所以宁可锁久一点:
 * 放早了,遮罩就只在 agent 每次调用前后闪一下,人看到的是「它什么时候在干活说不准」。
 *
 * 做法借自 ego-lite 浏览器:同一时刻只有一方持有;agent 明说拿起(`take_control`)、
 * 明说交还(`hand_off`);人随时能接管或停止,之后 agent 收到的是一个**硬停止**,不是
 * 「稍后重试」。和 ego 不同的两处:
 *
 * - **不懂握手的 agent 也要管住。** 没调 take_control 的,它一开始调工具就当它拿着,
 *   停下 {@link GRACE_MS} 后放下。两次调用之间它在想下一步,常常一想十几二十秒 ——
 *   这段时间遮罩得还在,不然人一动手,它下一刀下去画布一重载,人改到一半的字就没了。
 *   锁久了也不会卡住人:遮罩上就是「接管」。
 * - **明说拿着的也会过期。** ego 有常驻的浏览器和覆盖层;我们的 agent 是无状态 HTTP,
 *   可能说走就走。{@link IDLE_MS} 没有任何调用就交还给人。
 *
 * 任务名(task)和当前动作(doing)分开存:明说拿着期间每次工具调用都会换 doing,
 * 任务名要一直留在胶囊第一行 —— 混成一个字段的话,任务名只闪一下就被盖掉(和 Jevbot 联调时看到的)。
 *
 * 只认 MCP。agent 用它自己的写文件工具直接改 HTML 时我们看不见 —— 那一路靠的是改字时
 * 重读磁盘、旧文字对不上就拒绝(见 `deck.editText`)。
 */
export const GRACE_MS = 30_000
export const IDLE_MS = 120_000

/** 管控制权本身的工具。它们不算「agent 在干活」,也不受人接管的拦截。 */
export const CONTROL_TOOLS = new Set(['take_control', 'hand_off'])

/**
 * 人接管之后,agent 的每个工具收到的都是这段话。措辞学 ego:说清这是硬停止。
 * 不提 take_control:在 Jevbot 这类宿主里拿回控制权由宿主代做,agent 看不到那个工具,
 * 提了它只会自己去调、被拒、平白多一步。直连的 agent 看得到 take_control 的说明,照样知道怎么拿回。
 */
export const USER_IN_CONTROL =
  'USER_IN_CONTROL:用户在界面上接管了这份稿子。这是硬停止 —— 不要重试,不要换个工具绕过去。' +
  '结束这一轮,告诉用户你停在哪一步、还剩什么没做。等用户说继续再接着做。'

/** 人按了「停止」:这件事不做了。宿主认出这个前缀就直接中断这一轮。 */
export const USER_STOPPED = 'USER_STOPPED:用户停止了这项任务。结束这一轮,不要继续,也不要重试。'

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
  /**
   * 最近一次调用在做什么。doing 调用一结束就清(胶囊第二行只说此刻),可人在 agent 两次调用之间
   * 改字被拒时,理由得说得出它刚才在干什么 —— 只剩「agent 正在操作」,人不知道为什么被挡。
   */
  #last: string | undefined

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

    if (call.phase === 'start') {
      this.#running.set(call.id, call.label)
      this.#last = call.label
    } else {
      this.#running.delete(call.id)
    }
    const doing = [...this.#running.values()].at(-1)

    if (this.#state.holder === 'agent' && this.#state.explicit) {
      // 明说拿着的:每次调用都续期;任务名不动,只换「正在做什么」。
      const { doing: _previous, ...rest } = this.#state
      this.#set(doing ? { ...rest, doing } : rest)
      this.#expireAfter(this.timing.idleMs, IDLE_MESSAGE)
      return
    }

    if (doing) {
      this.#clearTimer()
      this.#set({ holder: 'agent', explicit: false, doing })
    } else {
      this.#set({ holder: 'agent', explicit: false })
      this.#expireAfter(this.timing.graceMs)
    }
  }

  take(task: string, waiting?: string): Control {
    const doing = [...this.#running.values()].at(-1)
    this.#set({
      holder: 'agent',
      explicit: true,
      task,
      ...(doing ? { doing } : {}),
      ...(waiting ? { waiting } : {}),
    })
    this.#expireAfter(this.timing.idleMs, IDLE_MESSAGE)
    return this.#state
  }

  handOff(message: string | undefined): Control {
    this.#clearTimer()
    this.#running.clear()
    // 留了话才带着任务名 —— 胶囊要说「哪件事做完了、留了什么话」;没留话就什么都不显示。
    this.#set(
      message
        ? { holder: 'none', explicit: false, ...this.#taskOnly(), message }
        : { holder: 'none', explicit: false },
    )
    return this.#state
  }

  takeOver(): Control {
    this.#clearTimer()
    this.#running.clear()
    this.#set({ holder: 'user', explicit: false, ...this.#taskOnly() })
    return this.#state
  }

  stop(): Control {
    this.#clearTimer()
    this.#running.clear()
    this.#set({ holder: 'user', explicit: false, ...this.#taskOnly(), stopped: true })
    return this.#state
  }

  release(): Control {
    this.#clearTimer()
    this.#last = undefined
    this.#set({ holder: 'none', explicit: false })
    return this.#state
  }

  /** 人发来的改稿子请求能不能做。不能就返回理由。 */
  blocksHuman(): string | undefined {
    if (this.#state.holder !== 'agent') return undefined
    const what = this.#state.task ?? this.#state.doing ?? this.#last
    const doing = what ? `「${what}」` : '操作'
    return `agent 正在${doing},等它停下再改(要马上改,先点「接管」)`
  }

  /** agent 的这个工具能不能跑。不能就返回给它的话。 */
  blocksAgent(tool: string): string | undefined {
    if (this.#state.holder !== 'user' || CONTROL_TOOLS.has(tool)) return undefined
    return this.#state.stopped ? USER_STOPPED : USER_IN_CONTROL
  }

  close(): void {
    this.#clearTimer()
  }

  #taskOnly(): { task?: string } {
    return this.#state.task ? { task: this.#state.task } : {}
  }

  #expireAfter(ms: number, message?: string): void {
    this.#clearTimer()
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#running.clear()
      this.#set(
        message
          ? { holder: 'none', explicit: false, ...this.#taskOnly(), message }
          : { holder: 'none', explicit: false },
      )
    }, ms)
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #set(next: Control): void {
    const prev = this.#state
    this.#state = next
    const keys = ['holder', 'explicit', 'task', 'doing', 'waiting', 'stopped', 'message'] as const
    if (keys.some((key) => prev[key] !== next[key])) this.onChange(next)
  }
}

const IDLE_MESSAGE = 'agent 两分钟没有动静,稿子交还给你了'
