import { describe, expect, it } from 'vitest'
import { recipePrompt } from './recipes.js'

describe('recipePrompt', () => {
  const prompt = recipePrompt({
    id: 'recap-credits',
    title: '电影级回顾片尾',
    summary: '回顾 + 名单',
  })

  it('指到配方文件,而不是把配方抄进来', () => {
    expect(prompt).toContain('recipes/recap-credits/RECIPE.md')
    expect(prompt).toContain('read_skill')
    expect(prompt).not.toContain('.s-recap')
  })

  it('留出用户贴内容的位置', () => {
    expect(prompt).toContain('我的内容')
  })

  it('不适用就直说,不编人名和数据', () => {
    expect(prompt).toContain('不适用')
    expect(prompt).toContain('不要编人名和数据')
  })

  it('没有 summary 也能生成', () => {
    expect(recipePrompt({ id: 'x', title: 'X' })).toContain('「X」')
  })
})
