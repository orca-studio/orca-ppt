import { describe, expect, it } from 'vitest'
import { countTopLevelSections } from './decks.js'

describe('countTopLevelSections', () => {
  it('数 .slides 的直接子 section', () => {
    const html = `<div class="slides"><section>1</section><section>2</section></div>`
    expect(countTopLevelSections(html)).toBe(2)
  })

  it('嵌套的纵向子页不各算一页', () => {
    const html = `<div class="slides">
      <section>1</section>
      <section><section>2a</section><section>2b</section></section>
    </div>`
    expect(countTopLevelSections(html)).toBe(2)
  })

  it('.slides 之前的 section 不算 —— 转场计划注释和页头不是页', () => {
    const html = `<section>页头不该算</section><div class="slides"><section>1</section></div>`
    expect(countTopLevelSections(html)).toBe(1)
  })

  it('不是 reveal 稿就返回 0', () => {
    expect(countTopLevelSections('<html><body>hi</body></html>')).toBe(0)
  })

  it('section 上带属性也认得', () => {
    const html = `<div class="slides"><section data-auto-animate data-hold="2.5">1</section></div>`
    expect(countTopLevelSections(html)).toBe(1)
  })
})
