import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Control } from '@orca-ppt/contracts'
import { DeckControl, USER_IN_CONTROL, USER_STOPPED } from './control.js'

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
    expect(control.state()).toEqual({ holder: 'agent', explicit: false, doing: '改第 3 页的文字' })

    call('a', 'done')
    // 调用结束,「正在做什么」就清掉 —— 胶囊第二行只说此刻
    expect(control.state()).toEqual({ holder: 'agent', explicit: false })
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
    expect(control.state()).toMatchObject({ holder: 'agent', doing: '截图' })

    call('a', 'done', '截图')
    vi.advanceTimersByTime(1_000)
    expect(control.state().holder).toBe('none')
  })

  it('拿着的时候拦人;两次调用之间被拦,理由里也说得出它刚才在干什么', () => {
    expect(control.blocksHuman()).toBeUndefined()
    call('a', 'start')
    expect(control.blocksHuman()).toContain('改第 3 页的文字')
    call('a', 'done')
    expect(control.blocksHuman()).toContain('改第 3 页的文字')
  })
})

describe('握手', () => {
  it('任务名一直在,「正在做什么」跟着每次调用换 —— 以前任务名只闪一下就被盖掉', () => {
    control.take('重排第 2 到 4 页的标题')
    call('a', 'start', '看稿子的状态')
    expect(control.state()).toMatchObject({ task: '重排第 2 到 4 页的标题', doing: '看稿子的状态' })
    call('a', 'done', '看稿子的状态')
    expect(control.state()).toEqual({
      holder: 'agent',
      explicit: true,
      task: '重排第 2 到 4 页的标题',
    })
    call('b', 'start', '改第 3 页的文字')
    expect(control.state()).toMatchObject({
      task: '重排第 2 到 4 页的标题',
      doing: '改第 3 页的文字',
    })
  })

  it('等批准:带 waiting 就设上,再 take 一次不带就清掉', () => {
    control.take('重排', '删掉第 5 页')
    expect(control.state()).toMatchObject({ task: '重排', waiting: '删掉第 5 页' })
    control.take('重排')
    expect(control.state().waiting).toBeUndefined()
  })

  it('明说拿着的不会几秒就放,要等它交还;留了话就带着任务名', () => {
    control.take('重排第 2 到 4 页')
    call('a', 'start')
    call('a', 'done')
    vi.advanceTimersByTime(5_000)
    expect(control.state()).toMatchObject({ holder: 'agent', explicit: true })

    control.handOff('第 3 页的数字请你确认一下')
    expect(control.state()).toEqual({
      holder: 'none',
      explicit: false,
      task: '重排第 2 到 4 页',
      message: '第 3 页的数字请你确认一下',
    })
  })

  it('交还时没留话,就什么都不剩 —— 胶囊不该显示', () => {
    control.take('重排')
    control.handOff(undefined)
    expect(control.state()).toEqual({ holder: 'none', explicit: false })
  })

  it('明说拿着之后长时间没动静,交还给人并说一声 —— agent 可能直接走了', () => {
    control.take('重排')
    vi.advanceTimersByTime(9_000)
    call('a', 'start')
    call('a', 'done')
    vi.advanceTimersByTime(9_000)
    expect(control.state().holder).toBe('agent')

    vi.advanceTimersByTime(1_000)
    expect(control.state()).toMatchObject({ holder: 'none', task: '重排' })
    expect(control.state().message).toContain('没有动静')
  })

  it('握手工具本身不算干活,不会自己把自己锁住', () => {
    control.handOff('好了')
    control.observe({ id: 'x', tool: 'hand_off', phase: 'done', label: '交还' })
    vi.advanceTimersByTime(5_000)
    expect(control.state()).toMatchObject({ holder: 'none', message: '好了' })
  })
})

describe('人接管 / 停止', () => {
  it('接管之后 agent 的工具一律硬停止,只有 take_control 放行;任务名留着', () => {
    control.take('重排')
    call('a', 'start')
    control.takeOver()
    expect(control.state()).toEqual({ holder: 'user', explicit: false, task: '重排' })
    expect(control.blocksHuman()).toBeUndefined()
    expect(control.blocksAgent('edit_text')).toBe(USER_IN_CONTROL)
    expect(control.blocksAgent('show_slide')).toBe(USER_IN_CONTROL)
    expect(control.blocksAgent('take_control')).toBeUndefined()
  })

  it('接管的话术不叫 agent 自己去调 take_control —— 宿主代管时它看不到那个工具', () => {
    expect(USER_IN_CONTROL).not.toContain('take_control')
    expect(USER_IN_CONTROL.startsWith('USER_IN_CONTROL:')).toBe(true)
  })

  it('停止和接管分开:agent 收到的是 USER_STOPPED', () => {
    control.take('重排')
    control.stop()
    expect(control.state()).toEqual({
      holder: 'user',
      explicit: false,
      task: '重排',
      stopped: true,
    })
    expect(control.blocksAgent('edit_text')).toBe(USER_STOPPED)
    expect(USER_STOPPED.startsWith('USER_STOPPED:')).toBe(true)
  })

  it('接管前挂着的放下计时不会把人的接管冲掉', () => {
    call('a', 'start')
    call('a', 'done')
    control.takeOver()
    vi.advanceTimersByTime(5_000)
    expect(control.state().holder).toBe('user')
  })

  it('人交还之后 agent 又能动了', () => {
    control.stop()
    control.release()
    expect(control.blocksAgent('edit_text')).toBeUndefined()
    expect(control.state()).toEqual({ holder: 'none', explicit: false })
  })
})

it('控制权查询不取得或续期控制权，接管后也可读取', () => {
  call('poll', 'start', '读取控制权', 'control_state')
  expect(control.state().holder).toBe('none')
  control.take('测试任务')
  vi.advanceTimersByTime(9_000)
  call('poll', 'start', '读取控制权', 'control_state')
  call('poll', 'done', '读取控制权', 'control_state')
  vi.advanceTimersByTime(1_000)
  expect(control.state().holder).toBe('none')
  control.takeOver()
  expect(control.blocksAgent('control_state')).toBeUndefined()
})

it('目标定位不取得或续期控制权，且服从人工接管', () => {
  call('track', 'start', '定位', 'visual_target')
  expect(control.state().holder).toBe('none')
  call('edit', 'start')
  call('edit', 'done')
  vi.advanceTimersByTime(900)
  call('track', 'start', '定位', 'visual_target')
  call('track', 'done', '定位', 'visual_target')
  vi.advanceTimersByTime(100)
  expect(control.state().holder).toBe('none')
  control.takeOver()
  expect(control.blocksAgent('visual_target')).toBeDefined()
})

it('批准等待的续期不能覆盖人工接管或停止', () => {
  control.take('test')
  control.takeOver()
  expect(() => control.take('test', undefined, true)).toThrow(USER_IN_CONTROL)
  expect(control.state().holder).toBe('user')
  control.take('explicit resume')
  expect(control.state().holder).toBe('agent')
})
