import { randomUUID } from 'node:crypto'

/**
 * 截图的往返。server 自己截不了图 —— 画布在壳里 —— 所以把请求推给壳,等它回话。
 *
 * 为什么值得这套管子:稿子好不好只有放映能回答。agent 改完能自己看一眼,才谈得上
 * 「改完确认」;否则它只能闭着眼改,等人来描述。
 */
export class CaptureBroker {
  readonly #pending = new Map<
    string,
    { resolve: (path: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  constructor(
    private readonly announce: (payload: {
      deckId: string
      requestId: string
      slide?: number
    }) => void,
    /** 壳没接上(没开窗口、正在重启)时别把调用方吊死。 */
    private readonly timeoutMs = 15_000,
  ) {}

  request(deckId: string, slide?: number): Promise<string> {
    const requestId = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        reject(new Error('界面没有回应 —— 应用开着吗?'))
      }, this.timeoutMs)
      timer.unref?.()

      this.#pending.set(requestId, { resolve, reject, timer })
      this.announce({ deckId, requestId, ...(slide === undefined ? {} : { slide }) })
    })
  }

  /** 壳交回结果。认不出的 requestId 忽略 —— 超时之后才回来的不该炸。 */
  settle(
    requestId: string,
    result: { path?: string | undefined; error?: string | undefined },
  ): boolean {
    const pending = this.#pending.get(requestId)
    if (!pending) return false
    this.#pending.delete(requestId)
    clearTimeout(pending.timer)

    if (result.path) pending.resolve(result.path)
    else pending.reject(new Error(result.error ?? '截图失败'))
    return true
  }

  /** 没人看着了,挂着的一律失败,别让 agent 干等。 */
  failAll(reason: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.#pending.clear()
  }
}
