import { describe, expect, it } from 'vitest'
import { appliesFrameMotionCheck, frameMotionVerdict, matchCutVerdict } from './self-check.js'

describe('frameMotionVerdict', () => {
  it('运动铺满整个区间时通过', () => {
    expect(frameMotionVerdict([2, 5, 9, 9, 6, 3]).pass).toBe(true)
  })

  it('变化集中在一两帧时判为跳变', () => {
    const verdict = frameMotionVerdict([0, 0, 0, 100, 0, 0, 0, 0, 0, 0])
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('跳变')
  })

  it('完全没变也不通过', () => {
    expect(frameMotionVerdict([0, 0, 0]).pass).toBe(false)
  })

  it('空区间不通过而不是抛异常', () => {
    expect(frameMotionVerdict([]).pass).toBe(false)
  })
})

describe('appliesFrameMotionCheck', () => {
  it('匹配剪辑走单独一条', () => {
    expect(appliesFrameMotionCheck('match-cut')).toBe(false)
    expect(appliesFrameMotionCheck('morph')).toBe(true)
  })
})

describe('matchCutVerdict', () => {
  it('锚重合且其余换掉才算数', () => {
    expect(matchCutVerdict({ anchorOverlap: 0.99, restChanged: 0.8 }).pass).toBe(true)
  })

  it('锚没对上就不通过', () => {
    expect(matchCutVerdict({ anchorOverlap: 0.6, restChanged: 0.9 }).pass).toBe(false)
  })

  it('画面没换等于没剪', () => {
    expect(matchCutVerdict({ anchorOverlap: 1, restChanged: 0.1 }).pass).toBe(false)
  })
})
