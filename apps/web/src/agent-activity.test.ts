import { describe, expect, it } from 'vitest'
import {
  caption,
  idle,
  isLive,
  LIVE_MS,
  prune,
  READ_MS,
  reduce,
  WRITE_MS,
  type Activity,
} from './agent-activity.js'

const T0 = 1_700_000_000_000

function act(over: Partial<Activity> = {}): Activity {
  return {
    id: 'a1',
    tool: 'show_slide',
    kind: 'read',
    phase: 'start',
    label: '让你看第 4 页',
    slides: [3],
    at: T0,
    ...over,
  }
}

describe('reduce', () => {
  it('start 记下正在跑的那次,并把涉及的页标上', () => {
    const state = reduce(idle, act())
    expect(state.running).toEqual({ id: 'a1', label: '让你看第 4 页', kind: 'read' })
    expect(state.touched.get(3)).toEqual({ kind: 'read', at: T0 })
  })

  it('done 把「正在跑」收掉,高亮留着 —— 人要有时间把视线移过去', () => {
    const start = reduce(idle, act({ tool: 'edit_text', kind: 'write', phase: 'start' }))
    const done = reduce(
      start,
      act({ tool: 'edit_text', kind: 'write', phase: 'done', at: T0 + 50 }),
    )
    expect(done.running).toBeUndefined()
    expect(done.touched.get(3)).toEqual({ kind: 'write', at: T0 + 50 })
  })

  it('另一次调用的 done 不该抹掉手上正在跑的那次', () => {
    const running = reduce(idle, act({ id: 'slow', label: '在看第 1 页' }))
    const other = reduce(running, act({ id: 'fast', phase: 'done', slides: [7] }))
    expect(other.running?.id).toBe('slow')
    expect(other.touched.has(7)).toBe(true)
  })

  it('写的高亮覆盖掉同一页之前读的高亮 —— 改过比看过要紧', () => {
    const read = reduce(idle, act({ slides: [2] }))
    const write = reduce(read, act({ id: 'b', kind: 'write', slides: [2], at: T0 + 10 }))
    expect(write.touched.get(2)?.kind).toBe('write')
  })

  it('失败记下来,只留最后一次 —— 攒一串错误没人看', () => {
    const first = reduce(
      idle,
      act({ phase: 'done', error: '找不到那段文字', label: '改第 3 页的文字' }),
    )
    expect(first.failed).toEqual({ label: '改第 3 页的文字', error: '找不到那段文字', at: T0 })
    const second = reduce(first, act({ id: 'c', phase: 'done', error: '有好几处', at: T0 + 5 }))
    expect(second.failed?.error).toBe('有好几处')
  })

  it('成功的调用不会把之前那条失败擦掉 —— 人可能还没看见', () => {
    const failed = reduce(idle, act({ phase: 'done', error: '找不到那段文字' }))
    const ok = reduce(failed, act({ id: 'd', phase: 'done', at: T0 + 5 }))
    expect(ok.failed?.error).toBe('找不到那段文字')
  })

  it('说不准哪一页时不标任何页 —— 宁可不高亮,也别高亮错的那页', () => {
    expect(reduce(idle, act({ tool: 'capture_slide', slides: [] })).touched.size).toBe(0)
  })
})

describe('prune', () => {
  it('读的高亮到点就灭', () => {
    const state = reduce(idle, act({ phase: 'done' }))
    expect(prune(state, T0 + READ_MS - 1).touched.size).toBe(1)
    expect(prune(state, T0 + READ_MS).touched.size).toBe(0)
  })

  it('写的高亮留得更久 —— 读是「它在看这儿」,写是「这儿被改了」', () => {
    const state = reduce(idle, act({ kind: 'write', phase: 'done' }))
    expect(prune(state, T0 + READ_MS).touched.size).toBe(1)
    expect(prune(state, T0 + WRITE_MS).touched.size).toBe(0)
  })

  it('没到点就原样返回,不制造新对象 —— 免得每一帧都触发重渲', () => {
    const state = reduce(idle, act())
    expect(prune(state, T0 + 100)).toBe(state)
  })

  it('done 一直没回来的调用,超时之后不再显示「正在跑」', () => {
    const state = reduce(idle, act())
    expect(prune(state, T0 + 1000).running).toBeDefined()
    expect(prune(state, T0 + LIVE_MS + 1).running).toBeUndefined()
  })

  it('失败的提示也会自己退场', () => {
    const state = reduce(idle, act({ phase: 'done', error: '改不了' }))
    expect(prune(state, T0 + WRITE_MS).failed).toBeUndefined()
  })
})

describe('isLive', () => {
  it('最近动过就算在,久没动静就算不在', () => {
    const state = reduce(idle, act())
    expect(isLive(state, T0 + LIVE_MS - 1)).toBe(true)
    expect(isLive(state, T0 + LIVE_MS)).toBe(false)
  })

  it('一次都没动过时不算在线 —— 别默认它连上了', () => {
    expect(isLive(idle, T0)).toBe(false)
  })
})

describe('caption', () => {
  it('正在跑的优先显示', () => {
    expect(caption(reduce(idle, act()))).toEqual({ text: '让你看第 4 页', tone: 'busy' })
  })

  it('跑完了就显示最近那条失败', () => {
    const state = reduce(idle, act({ phase: 'done', error: '找不到那段文字' }))
    expect(caption(state)).toEqual({ text: '让你看第 4 页:找不到那段文字', tone: 'failed' })
  })

  it('没动静就什么都不显示 —— 常驻一行字只会变成背景噪音', () => {
    expect(caption(idle)).toBeUndefined()
    expect(caption(reduce(idle, act({ phase: 'done' })))).toBeUndefined()
  })
})
