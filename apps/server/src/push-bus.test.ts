import { describe, expect, it } from 'vitest'
import type { PushEnvelope } from '@orca-ppt/contracts'
import { PushBus } from './push-bus.js'

describe('PushBus', () => {
  it('sequence 按连接各自递增,不共用一个计数器', () => {
    const bus = new PushBus()
    const a: PushEnvelope[] = []
    const b: PushEnvelope[] = []
    bus.attach('a', (e) => a.push(e))
    bus.broadcast('deck.changed', {
      deckId: 'd',
      slides: [],
      slideCount: 0,
      slideTitles: [],
      pageTypes: [],
      previewUrl: '',
    })
    bus.attach('b', (e) => b.push(e))
    bus.broadcast('deck.changed', {
      deckId: 'd',
      slides: [],
      slideCount: 0,
      slideTitles: [],
      pageTypes: [],
      previewUrl: '',
    })

    expect(a.map((e) => e.sequence)).toEqual([0, 1])
    expect(b.map((e) => e.sequence)).toEqual([0])
  })

  it('断开后不再收推送', () => {
    const bus = new PushBus()
    const received: PushEnvelope[] = []
    bus.attach('a', (e) => received.push(e))
    bus.detach('a')
    bus.broadcast('deck.changed', {
      deckId: 'd',
      slides: [],
      slideCount: 0,
      slideTitles: [],
      pageTypes: [],
      previewUrl: '',
    })
    expect(received).toHaveLength(0)
    expect(bus.connectionCount).toBe(0)
  })
})
