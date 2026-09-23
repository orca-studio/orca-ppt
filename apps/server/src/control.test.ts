import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Control } from '@orca-ppt/contracts'
import { DeckControl, USER_IN_CONTROL } from './control.js'

let changes: Control[]
let control: DeckControl

const call = (id: string, phase: 'start' | 'done', label = '改第 3 页的文字', tool = 'edit_text') =>
  control.observe({ id, tool, phase, label })

beforeEach(() => {
  vi.useFakeTimers()
  changes = []
  control = new DeckControl((state) => changes.push(state), { graceMs: 1_000, idleMs: 10_000 })
})

afterEach(() => {
  control.close()
  vi.useRealTimers()
})

describe('不懂握手的 agent:从调用猜', () => {
  it('一次调用开始就拿着,结束后再留一会儿才放下', () => {
    call('a', 'start')
    expect(control.state()).toEqual({ holder: 'agent', explicit: false, label: '改第 3 页的文字' })

    call('a', 'done')
    vi.advanceTimersByTime(999)
    expect(control.state().holder).toBe('agent')
    vi.advanceTimersByTime(1)
    expect(control.state()).toEqual({ holder: 'none', explicit: false })
  })

  it('留的那一会儿里又来一次调用,就接着拿着,不闪一下', () => {
    call('a', 'start', '看稿子的状态')
    call('a', 'done', '看稿子的状态')
    vi.advanceTimersByTime(600)
    call('b', 'start')
    vi.advanceTimersByTime(600)
    expect(control.state().holder).toBe('agent')
    expect(changes.every((state) => state.holder === 'agent')).toBe(true)
  })

  it('并发的调用全部结束才开始计时', () => {
    call('a', 'start', '截图')
    call('b', 'start')
    call('b', 'done')
    vi.advanceTimersByTime(5_000)
    expect(control.state()).toMatchObject({ holder: 'agent', label: '截图' })

    call('a', 'done', '截图')
    vi.advanceTimersByTime(1_000)
    expect(control.state().holder).toBe('none')
  })

  it('拿着的时候拦人,理由里说得出它在干什么', () => {
    expect(control.blocksHuman()).toBeUndefined()
    call('a', 'start')
    expect(control.blocksHuman()).toContain('改第 3 页的文字')
  })
})

describe('握手', () => {
  it('明说拿着的不会几秒就放,要等它交还', () => {
    control.take('重排第 2 到 4 页')
    call('a', 'start')
    call('a', 'done')
    vi.advanceTimersByTime(5_000)
    expect(control.state()).toMatchObject({ holder: 'agent', explicit: true })

    control.handOff('第 3 页的数字请你确认一下')
    expect(control.state()).toEqual({
      holder: 'none',
      explicit: false,
      message: '第 3 页的数字请你确认一下',
    })
  })

  it('明说拿着之后长时间没动静,交还给人并说一声 —— agent 可能直接走了', () => {
    control.take('重排')
    vi.advanceTimersByTime(9_000)
    call('a', 'start')
    call('a', 'done')
    vi.advanceTimersByTime(9_000)
    expect(control.state().holder).toBe('agent')

    vi.advanceTimersByTime(1_000)
    expect(control.state().holder).toBe('none')
    expect(control.state().message).toContain('没有动静')
  })

  it('握手工具本身不算干活,不会自己把自己锁住', () => {
    control.handOff('好了')
    control.observe({ id: 'x', tool: 'hand_off', phase: 'done', label: '交还' })
    vi.advanceTimersByTime(5_000)
    expect(control.state()).toMatchObject({ holder: 'none', message: '好了' })
  })
})

describe('人接管', () => {
  it('之后 agent 的工具一律硬停止,只有 take_control 放行', () => {
    call('a', 'start')
    control.takeOver()
    expect(control.state()).toEqual({ holder: 'user', explicit: false })
    expect(control.blocksHuman()).toBeUndefined()
    expect(control.blocksAgent('edit_text')).toBe(USER_IN_CONTROL)
    expect(control.blocksAgent('show_slide')).toBe(USER_IN_CONTROL)
    expect(control.blocksAgent('take_control')).toBeUndefined()
  })

  it('接管前挂着的放下计时不会把人的接管冲掉', () => {
    call('a', 'start')
    call('a', 'done')
    control.takeOver()
    vi.advanceTimersByTime(5_000)
    expect(control.state().holder).toBe('user')
  })

  it('人交还之后 agent 又能动了', () => {
    control.takeOver()
    control.release()
    expect(control.blocksAgent('edit_text')).toBeUndefined()
    expect(control.state()).toEqual({ holder: 'none', explicit: false })
  })
})
