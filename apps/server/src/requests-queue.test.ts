import { describe, expect, it, vi } from 'vitest'
import type { Anchor } from '@orca-ppt/contracts'
import { RequestQueue } from './requests-queue.js'

const anchor: Anchor = {
  kind: 'element',
  slide: 3,
  selector: 'h2',
  box: { x: 180, y: 220, w: 1560, h: 120 },
  note: '这儿太挤',
}

describe('RequestQueue', () => {
  it('挂一处锚,agent 取走后队列清空', () => {
    const queue = new RequestQueue(vi.fn())
    queue.add('/d', { kind: 'anchor', anchor })
    expect(queue.list('/d')).toHaveLength(1)

    const taken = queue.take('/d')
    expect(taken[0]).toMatchObject({ kind: 'anchor', anchor: { slide: 3 } })
    expect(queue.list('/d')).toEqual([])
  })

  it('同一个阶段连点两次只排一次 —— 排两次等于让 agent 白跑', () => {
    const queue = new RequestQueue(vi.fn())
    queue.add('/d', { kind: 'phase', phase: 'outline' })
    queue.add('/d', { kind: 'phase', phase: 'outline' })
    expect(queue.list('/d')).toHaveLength(1)
  })

  it('不同阶段各排各的', () => {
    const queue = new RequestQueue(vi.fn())
    queue.add('/d', { kind: 'phase', phase: 'brief' })
    queue.add('/d', { kind: 'phase', phase: 'outline' })
    expect(queue.list('/d').map((r: any) => r.phase)).toEqual(['brief', 'outline'])
  })

  it('多处锚都留着 —— 一次可以点好几处再一起说', () => {
    const queue = new RequestQueue(vi.fn())
    queue.add('/d', { kind: 'anchor', anchor })
    queue.add('/d', { kind: 'anchor', anchor: { ...anchor, slide: 1 } })
    expect(queue.list('/d')).toHaveLength(2)
  })

  it('两份 deck 的队列互不相干', () => {
    const queue = new RequestQueue(vi.fn())
    queue.add('/a', { kind: 'anchor', anchor })
    queue.add('/b', { kind: 'phase', phase: 'build' })
    expect(queue.take('/a')).toHaveLength(1)
    expect(queue.list('/b')).toHaveLength(1)
  })

  it('每次变动都报出去,界面才知道要显示「等 agent 来取」', () => {
    const onChange = vi.fn()
    const queue = new RequestQueue(onChange)
    const id = queue.add('/d', { kind: 'anchor', anchor })
    queue.remove('/d', id)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange.mock.calls[1]![1]).toEqual([])
  })

  it('删一个不存在的不报变动', () => {
    const onChange = vi.fn()
    const queue = new RequestQueue(onChange)
    queue.remove('/d', '不存在')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('空队列取走不报变动', () => {
    const onChange = vi.fn()
    const queue = new RequestQueue(onChange)
    expect(queue.take('/d')).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })
})
