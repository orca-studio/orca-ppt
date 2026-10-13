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

  it('没连上 Orca PPT 时,先转告怎么装、怎么连', () => {
    expect(prompt).toContain('https://github.com/orca-studio/orca-ppt')
    expect(prompt).toContain('claude mcp add --transport http orca-ppt http://127.0.0.1:6722/mcp')
    expect(prompt).toContain('不要凭印象做')
  })

  it('样稿指到 examples 时,路径跟着走', () => {
    expect(prompt).toContain('recipes/recap-credits/index.html')
    const pointed = recipePrompt({
      id: 'drink-showcase',
      title: 'D',
      sample: 'examples/drink-showcase',
    })
    expect(pointed).toContain('examples/drink-showcase/index.html')
    expect(pointed).toContain('recipes/drink-showcase/RECIPE.md')
  })

  it('从样稿起头:先读样稿,用 create_deck 复制它,不从空白重写', () => {
    expect(prompt).toContain('再读样稿 `recipes/recap-credits/index.html`')
    expect(prompt).toContain('from 填 `recipe:recap-credits`')
    expect(prompt).toContain('不要从空白重写')
  })

  it('自检要看图,点名 capture_slide', () => {
    expect(prompt).toContain('capture_slide')
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
