import { describe, expect, it } from 'vitest'
import { recipePrompt } from './recipes.js'

describe('recipePrompt', () => {
  const prompt = recipePrompt({
    id: 'recap-credits',
    title: '电影级回顾片尾',
    summary: '回顾 + 名单',
  })

  it('指到配方和样稿,而不是把配方抄进来', () => {
    expect(prompt).toContain('`recipe:recap-credits`')
    expect(prompt).toContain('recipes/recap-credits/RECIPE.md')
    expect(prompt).toContain('recipes/recap-credits/index.html')
    expect(prompt).not.toContain('.s-recap')
  })

  it('怎么做交给 skill:只指到 references/remake.md,不在这里列工具用法', () => {
    expect(prompt).toContain('references/remake.md')
    expect(prompt).not.toContain('edit_text')
    expect(prompt).not.toContain('capture_slide')
  })

  it('人名和数据不编 —— 这一句留在提示词里', () => {
    expect(prompt).toContain('人名和数据不要编')
  })

  it('没连上 Orca PPT 时,照 llms.txt 那一句装好连上,做不到就转告', () => {
    expect(prompt).toContain(
      '读 https://ppt.orca-studio.ai/llms.txt ，帮我装好 Orca PPT 应用，并把你自己连上它。',
    )
    expect(prompt).toContain('原样转告我')
    expect(prompt).toContain('不要凭印象做')
  })

  it('有 orca-ppt 命令也算连上了', () => {
    expect(prompt).toContain('`orca-ppt` 命令')
  })

  it('样稿指到 examples 时,路径跟着走', () => {
    const pointed = recipePrompt({
      id: 'drink-showcase',
      title: 'D',
      sample: 'examples/drink-showcase',
    })
    expect(pointed).toContain('examples/drink-showcase/index.html')
    expect(pointed).toContain('recipes/drink-showcase/RECIPE.md')
  })

  it('有内容槽位就列成清单,没有就留一个自由贴的位置', () => {
    const listed = recipePrompt({ id: 'x', title: 'X', slots: ['节点', '封面'] })
    expect(listed).toContain('- 节点:\n- 封面:')
    expect(prompt).toContain('在这里贴上')
  })

  it('没有 summary 也能生成', () => {
    expect(recipePrompt({ id: 'x', title: 'X' })).toContain('「X」')
  })
})
