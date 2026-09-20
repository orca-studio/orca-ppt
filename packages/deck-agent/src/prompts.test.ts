import { describe, expect, it } from 'vitest'
import { phasePrompt } from './prompts.js'

const context = { request: '讲讲 Q3 的增长', skillPath: '/s/skill' }

describe('phasePrompt', () => {
  it('每个阶段都指明产物路径', () => {
    expect(phasePrompt('brief', context)).toContain('.deck/brief.json')
    expect(phasePrompt('outline', context)).toContain('.deck/outline.json')
    expect(phasePrompt('build', context)).toContain('deck.html')
  })

  it('brief 明确不许提问', () => {
    const prompt = phasePrompt('brief', context)
    expect(prompt).toContain('不要提问')
    expect(prompt).toContain('assumptions')
    expect(prompt).toContain('讲讲 Q3 的增长')
  })

  it('outline 把「严禁用」那三条写出来,而不是只说「读规范」', () => {
    const prompt = phasePrompt('outline', context)
    expect(prompt).toContain('先有内容,再挑版式')
    expect(prompt).toContain('凑不满的格子不硬撑')
    expect(prompt).toContain('layoutReason')
  })

  it('plan 要求先写关系再选手法,并列全手法', () => {
    const prompt = phasePrompt('plan', context)
    expect(prompt).toContain('先写两页的「关系」,再选手法')
    for (const technique of ['shared-element', 'morph', 'match-cut', 'mask-cut']) {
      expect(prompt).toContain(technique)
    }
  })

  it('build 明确前面的产物是决定,不许在这一步改', () => {
    expect(phasePrompt('build', context)).toContain('不要在这一步改版式')
  })

  it('theme 带上现成主题让它先挑', () => {
    const prompt = phasePrompt('theme', { ...context, themes: ['editorial-forest', 'clearing'] })
    expect(prompt).toContain('editorial-forest、clearing')
    expect(prompt).toContain('不要在稿子里改颜色')
  })

  it('找不到 skill 时要求说明,而不是凭印象编规范', () => {
    const prompt = phasePrompt('outline', { request: 'x' })
    expect(prompt).toContain('不要凭印象编')
  })

  it('每个阶段都要求写完就停 —— 一口气写到底就看不见中间的判断', () => {
    for (const phase of ['brief', 'theme', 'outline', 'plan'] as const) {
      expect(phasePrompt(phase, context)).toContain('写完就停')
    }
  })
})
