import type { PushChannel, PushData, PushEnvelope } from '@orca-pptcode/contracts'

/**
 * push 信封带**每连接**单调递增的 sequence。客户端据此发现丢帧并重同步 ——
 * 全局递增做不到这件事,因为不同连接订阅的东西不一样。
 */
export class PushBus {
  readonly #sinks = new Map<string, { send: (envelope: PushEnvelope) => void; sequence: number }>()

  attach(connectionId: string, send: (envelope: PushEnvelope) => void): void {
    this.#sinks.set(connectionId, { send, sequence: 0 })
  }

  detach(connectionId: string): void {
    this.#sinks.delete(connectionId)
  }

  broadcast<C extends PushChannel>(channel: C, data: PushData<C>): void {
    for (const sink of this.#sinks.values()) {
      sink.send({ channel, sequence: sink.sequence++, data })
    }
  }

  get connectionCount(): number {
    return this.#sinks.size
  }
}
