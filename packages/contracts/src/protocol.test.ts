import { describe, expect, it } from 'vitest'
import { PushEnvelope, RequestEnvelope, parseParams, parsePush } from './protocol.js'

describe('protocol', () => {
  it('拒绝未知方法', () => {
    expect(RequestEnvelope.safeParse({ id: '1', method: 'deck.nuke', params: {} }).success).toBe(
      false,
    )
  })

  it('校验参数载荷', () => {
    expect(() => parseParams('deck.open', { path: 42 })).toThrow()
    expect(parseParams('deck.open', { path: '/tmp/d' })).toEqual({ path: '/tmp/d' })
  })

  it('挂一处锚要带页号和几何', () => {
    const params = parseParams('requests.add', {
      deckId: 'd1',
      kind: 'anchor',
      anchor: {
        kind: 'element',
        slide: 3,
        selector: 'section:nth-child(4) > h2',
        box: { x: 180, y: 220, w: 1560, h: 120 },
        note: '这儿太挤',
      },
    })
    expect(params).toMatchObject({ kind: 'anchor', anchor: { slide: 3 } })
  })

  it('挂一个阶段请求', () => {
    expect(parseParams('requests.add', { deckId: 'd1', kind: 'phase', phase: 'outline' })).toEqual({
      deckId: 'd1',
      kind: 'phase',
      phase: 'outline',
    })
  })

  it('不认识的阶段名过不了', () => {
    expect(() =>
      parseParams('requests.add', { deckId: 'd', kind: 'phase', phase: '排版' }),
    ).toThrow()
  })

  it('push 信封带 sequence', () => {
    expect(PushEnvelope.safeParse({ channel: 'deck.changed', data: {} }).success).toBe(false)
    const parsed = PushEnvelope.parse({ channel: 'deck.changed', sequence: 0, data: {} })
    expect(parsed.sequence).toBe(0)
  })

  it('校验推送数据', () => {
    expect(() =>
      parsePush('deck.changed', { deckId: 'd1', slides: 'nope', slideCount: 0, previewUrl: '' }),
    ).toThrow()
  })

  it('deck.changed 带上 previewUrl —— 成品第一次出现时界面靠它接上画布', () => {
    const data = parsePush('deck.changed', {
      deckId: 'd1',
      slides: [],
      slideCount: 4,
      slideTitles: [null, null, null, null],
      pageTypes: ['cover', null, null, 'closing'],
      previewUrl: 'http://127.0.0.1:1/p/x/deck.html',
    })
    expect(data.previewUrl).toContain('127.0.0.1')
    // 没标类型的页是 null,不是空串 —— 「没标」和「标成了空」是两回事。
    expect(data.pageTypes).toEqual(['cover', null, null, 'closing'])
  })
})
