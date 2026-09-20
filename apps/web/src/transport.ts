import type {
  PushChannel,
  PushData,
  PushEnvelope,
  RequestMethod,
  RequestParams,
  RequestResult,
} from '@orca-pptcode/contracts'

export type TransportState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/**
 * 客户端传输层是显式状态机,断开期间排队出站请求 —— 不排队的话,重连那一瞬间用户
 * 点的东西会静默消失。
 *
 * push 信封带每连接单调递增的 sequence,缺号说明丢了帧,该重同步。
 */
export class Transport {
  #socket: WebSocket | undefined
  #state: TransportState = 'closed'
  #queue: string[] = []
  #pending = new Map<string, (response: unknown) => void>()
  #expectedSequence = 0
  #listeners = new Map<PushChannel, Set<(data: unknown) => void>>()

  onStateChange: (state: TransportState) => void = () => {}
  /** 发现丢帧。调用方据此重新拉一遍全量状态。 */
  onDesync: () => void = () => {}

  constructor(private readonly url: string) {}

  get state(): TransportState {
    return this.#state
  }

  connect(): void {
    this.#setState(this.#state === 'closed' ? 'connecting' : 'reconnecting')
    const socket = new WebSocket(this.url)
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#setState('open')
      this.#expectedSequence = 0
      for (const message of this.#queue.splice(0)) socket.send(message)
    })
    socket.addEventListener('message', (event) => this.#receive(String(event.data)))
    socket.addEventListener('close', () => {
      this.#setState('reconnecting')
      setTimeout(() => this.connect(), 500)
    })
  }

  request<M extends RequestMethod>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> {
    const id = crypto.randomUUID()
    const message = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (response) => {
        const envelope = response as
          { ok: true; data: RequestResult<M> } | { ok: false; error: { message: string } }
        if (envelope.ok) resolve(envelope.data)
        else reject(new Error(envelope.error.message))
      })
      if (this.#state === 'open' && this.#socket) this.#socket.send(message)
      else this.#queue.push(message)
    })
  }

  subscribe<C extends PushChannel>(channel: C, handler: (data: PushData<C>) => void): () => void {
    const set = this.#listeners.get(channel) ?? new Set()
    set.add(handler as (data: unknown) => void)
    this.#listeners.set(channel, set)
    return () => set.delete(handler as (data: unknown) => void)
  }

  #receive(raw: string): void {
    const message = JSON.parse(raw) as { id?: string } & Partial<PushEnvelope>
    if (message.id) {
      this.#pending.get(message.id)?.(message)
      this.#pending.delete(message.id)
      return
    }
    if (typeof message.sequence !== 'number' || !message.channel) return
    if (message.sequence !== this.#expectedSequence) this.onDesync()
    this.#expectedSequence = message.sequence + 1
    for (const handler of this.#listeners.get(message.channel) ?? []) handler(message.data)
  }

  #setState(state: TransportState): void {
    if (this.#state === state) return
    this.#state = state
    this.onStateChange(state)
  }
}
