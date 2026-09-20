import { randomUUID } from 'node:crypto'
import type { Anchor, DeckPhase, PendingRequest } from '@orca-ppt/contracts'

/**
 * 待办队列。人在界面上做了一件需要 agent 干活的事(取一处锚、点一个阶段的「跑」),
 * 挂在这儿等 agent 来拉。
 *
 * 为什么是拉不是推:MCP 没有可靠的「把消息推进用户对话」的原语。notification 能告诉
 * 宿主「有东西变了」,但不保证正在跑的 agent 会去看。与其假装能推,不如让方向诚实。
 */
export class RequestQueue {
  readonly #byDeck = new Map<string, PendingRequest[]>()

  constructor(private readonly onChange: (deckId: string, requests: PendingRequest[]) => void) {}

  add(
    deckId: string,
    input: { kind: 'anchor'; anchor: Anchor } | { kind: 'phase'; phase: DeckPhase },
  ): string {
    const id = randomUUID()
    const request: PendingRequest =
      input.kind === 'anchor'
        ? { id, kind: 'anchor', anchor: input.anchor, createdAt: Date.now() }
        : { id, kind: 'phase', phase: input.phase, createdAt: Date.now() }

    const queue = this.#byDeck.get(deckId) ?? []
    // 同一个阶段连点两次只排一次 —— 排两次等于让 agent 白跑一遍。
    const deduped =
      request.kind === 'phase'
        ? queue.filter((item) => !(item.kind === 'phase' && item.phase === request.phase))
        : queue
    this.#byDeck.set(deckId, [...deduped, request])
    this.#announce(deckId)
    return id
  }

  list(deckId: string): PendingRequest[] {
    return this.#byDeck.get(deckId) ?? []
  }

  /** agent 取走。取完就清空 —— 队列的语义是「还没交给 agent 的」。 */
  take(deckId: string): PendingRequest[] {
    const queue = this.#byDeck.get(deckId) ?? []
    if (queue.length === 0) return []
    this.#byDeck.set(deckId, [])
    this.#announce(deckId)
    return queue
  }

  remove(deckId: string, id: string): void {
    const queue = this.#byDeck.get(deckId) ?? []
    const next = queue.filter((item) => item.id !== id)
    if (next.length === queue.length) return
    this.#byDeck.set(deckId, next)
    this.#announce(deckId)
  }

  #announce(deckId: string): void {
    this.onChange(deckId, this.list(deckId))
  }
}
