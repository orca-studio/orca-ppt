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

  it.each([
    ['双引号', '<div class="slides">'],
    ['单引号', "<div class='slides'>"],
    ['不带引号', '<div class=slides>'],
    ['和别的类名并存', '<div class="deck slides dark">'],
    ['class 前后有空格', '<div class = "slides">'],
  ])('%s 都认得 —— 都是合法 HTML,只认一种写法会静默数出 0 页', (_name, open) => {
    expect(countTopLevelSections(`${open}<section>1</section><section>2</section></div>`)).toBe(2)
  })

  it('类名只是包含 slides 不算(slideshow)', () => {
    expect(countTopLevelSections('<div class="slideshow"><section>1</section></div>')).toBe(0)
  })

  it('不是 reveal 稿就返回 0', () => {
    expect(countTopLevelSections('<html><body>hi</body></html>')).toBe(0)
  })

  it('section 上带属性也认得', () => {
    const html = `<div class="slides"><section data-auto-animate data-hold="2.5">1</section></div>`
    expect(countTopLevelSections(html)).toBe(1)
  })
})
