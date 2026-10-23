// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Transport } from './transport.js'

class FakeSocket extends EventTarget {
  static all: FakeSocket[] = []
  sent: string[] = []
  constructor(readonly url: string) {
    super()
    FakeSocket.all.push(this)
  }
  send(message: string) {
    this.sent.push(message)
  }
  close() {
    this.dispatchEvent(new Event('close'))
  }
}

afterEach(() => {
  FakeSocket.all = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Transport', () => {
  it('断线自己重连', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    const transport = new Transport('ws://x')
    transport.connect()
    FakeSocket.all[0]!.close()
    vi.advanceTimersByTime(600)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('close 之后不再重连,也不再收推送 —— 旧连接活着会重复响应', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    const transport = new Transport('ws://x')
    const seen: unknown[] = []
    transport.subscribe('present.stop', (data) => seen.push(data))
    transport.connect()
    transport.close()
    vi.advanceTimersByTime(600)
    expect(FakeSocket.all).toHaveLength(1)
    expect(transport.state).toBe('closed')
    FakeSocket.all[0]!.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ channel: 'present.stop', sequence: 0, data: { deckId: 'd' } }),
      }),
    )
    expect(seen).toEqual([])
  })
})
