import { describe, expect, it } from 'vitest'
import { downstreamOf, validateOutline } from './phases.js'

const slide = {
  index: 0,
  subject: '增长',
  layout: 'headline',
  points: ['三个来源'],
  layoutReason: '只有一个论点,不该进格子',
}

describe('downstreamOf', () => {
  it('改了 outline,plan 之后的都得重跑', () => {
    expect(downstreamOf('outline')).toEqual(['plan', 'build', 'review'])
  })

  it('最后一个阶段没有下游', () => {
    expect(downstreamOf('review')).toEqual([])
  })
})

describe('validateOutline', () => {
  it('合规的大纲没有问题', () => {
    expect(validateOutline([slide])).toEqual([])
  })

  it('没写版式理由要报 —— 版式是被内容挑中的', () => {
    const issues = validateOutline([{ ...slide, layoutReason: '  ' }])
    expect(issues[0]?.message).toContain('为什么选这个版式')
  })

  it('格子凑不满要报', () => {
    const issues = validateOutline([{ ...slide, layout: 'three-grid', points: ['一项'] }])
    expect(issues.some((i) => i.message.includes('凑不满'))).toBe(true)
  })

  it('空页报主角和内容两条', () => {
    const issues = validateOutline([{ ...slide, subject: '', points: [] }])
    expect(issues.length).toBe(2)
  })
})
