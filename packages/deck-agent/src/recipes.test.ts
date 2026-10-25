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
    expect(prompt).toContain('一条也别留')
  })

  it('没连上 Orca PPT 时,照 llms.txt 那一句装好连上,做不到就转告', () => {
    expect(prompt).toContain(
      '读 https://ppt.orca-studio.ai/llms.txt ，帮我装好 Orca PPT 应用，并把你自己连上它。',
    )
    expect(prompt).toContain('原样转告我')
    expect(prompt).toContain('不要凭印象做')
  })

  it('建好马上打开,改页走 read_page / write_page,不用自己的文件工具改', () => {
    expect(prompt.indexOf('open_deck 打开它')).toBeLessThan(prompt.indexOf('改字用 edit_text'))
    expect(prompt).toContain('edit_pages 插一页')
    expect(prompt).toContain('write_page')
    expect(prompt).toContain('不要用你自己的文件工具改 deck.html')
  })

  it('交付:在 Orca PPT 里看,发给别人用 export_pptx', () => {
    expect(prompt).toContain('在 Orca PPT 里看')
    expect(prompt).toContain('export_pptx')
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

  it('样稿要读完 —— 一次返回不完,带着 next 接着读', () => {
    expect(prompt).toContain('next 不为空就带着它接着读')
  })

  it('自检要看图,点名 capture_slide,每一页都看', () => {
    expect(prompt).toContain('capture_slide')
    expect(prompt).toContain('每一页')
  })

  it('改字点名 edit_text,不写脚本整份替换', () => {
    expect(prompt).toContain('改字用 edit_text')
    expect(prompt).toContain('不要写脚本整份替换')
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
