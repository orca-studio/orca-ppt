import { describe, expect, it } from 'vitest'
import { validateArtifact } from './validate.js'

const brief = {
  topic: 'Q3 增长',
  audience: '投资人',
  tone: '克制',
  mode: 'report',
  slideCount: 5,
  assumptions: ['没说时长,按五分钟'],
}

const slide = {
  index: 0,
  subject: '增长',
  layout: 'headline',
  points: ['三个来源'],
  layoutReason: '只有一个论点,不该进格子',
}

describe('validateArtifact', () => {
  it('合规的 brief 过', () => {
    expect(validateArtifact('brief', brief)).toEqual({ ok: true, issues: [] })
  })

  it('字段缺了会指出是哪个字段', () => {
    const check = validateArtifact('brief', { ...brief, mode: undefined })
    expect(check.ok).toBe(false)
    expect(check.issues.join()).toContain('mode')
  })

  it('theme 要写理由 —— 只给个名字等于没选', () => {
    expect(validateArtifact('theme', { name: 'clearing', reason: '' }).ok).toBe(false)
    expect(validateArtifact('theme', { name: 'clearing', reason: '米色纸面配得上' }).ok).toBe(true)
  })

  it('空大纲不算数', () => {
    expect(validateArtifact('outline', { slides: [] }).ok).toBe(false)
  })

  it('大纲跑确定性检查,问题带页号', () => {
    const check = validateArtifact('outline', {
      slides: [{ ...slide, layout: 'three-grid', points: ['一项'] }],
    })
    expect(check.ok).toBe(false)
    expect(check.issues[0]).toContain('第 1 页')
    expect(check.issues[0]).toContain('凑不满')
  })

  it('转场必须是相邻两页', () => {
    const check = validateArtifact('plan', {
      transitions: [{ from: 0, to: 2, relation: '同一条轴', technique: 'morph' }],
    })
    expect(check.issues[0]).toContain('相邻')
  })

  it('同一次翻页写两遍要报', () => {
    const check = validateArtifact('plan', {
      transitions: [
        { from: 0, to: 1, relation: 'a', technique: 'morph' },
        { from: 0, to: 1, relation: 'b', technique: 'handoff' },
      ],
    })
    expect(check.issues.join()).toContain('写了两次')
  })

  it('没写关系要报 —— 先有关系才谈得上选手法', () => {
    const check = validateArtifact('plan', {
      transitions: [{ from: 0, to: 1, relation: '  ', technique: 'morph' }],
    })
    expect(check.issues.join()).toContain('没写两页的关系')
  })

  it('匹配剪辑没有锚就没法验,要报', () => {
    const check = validateArtifact('plan', {
      transitions: [{ from: 0, to: 1, relation: '同一个圆', technique: 'match-cut' }],
    })
    expect(check.issues.join()).toContain('anchorSelector')
  })

  it('匹配剪辑带上锚就过', () => {
    const check = validateArtifact('plan', {
      transitions: [
        { from: 0, to: 1, relation: '同一个圆', technique: 'match-cut', anchorSelector: '#dial' },
      ],
    })
    expect(check.ok).toBe(true)
  })

  it('不认识的手法过不了 schema', () => {
    const check = validateArtifact('plan', {
      transitions: [{ from: 0, to: 1, relation: 'x', technique: 'cross-dissolve' }],
    })
    expect(check.ok).toBe(false)
  })

  it('build 和 review 不是 JSON 产物,这里不拦', () => {
    expect(validateArtifact('build', undefined).ok).toBe(true)
    expect(validateArtifact('review', undefined).ok).toBe(true)
  })
})
