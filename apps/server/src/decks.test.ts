import { describe, expect, it } from 'vitest'
import { countTopLevelSections, readPageTypes, readSlideTitles } from './decks.js'

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

describe('readSlideTitles', () => {
  const wrap = (sections: string) => `<div class="slides">${sections}</div>`

  it('t-h1 排在 t-display 前面 —— 有的页用 t-display 放的是章节号', () => {
    const html = wrap(
      '<section><p class="t-display t-on-surface">01</p><p class="t-h1">The quarter.</p></section>',
    )
    expect(readSlideTitles(html)).toEqual(['The quarter.'])
  })

  it('没有 t-h1 时才用 t-display —— 封面就是这种', () => {
    expect(readSlideTitles(wrap('<section><p class="t-display">THANK YOU</p></section>'))).toEqual([
      'THANK YOU',
    ])
  })

  it('类名整词匹配:t-h1 不撞 t-h10,也能从多类名里认出来', () => {
    expect(readSlideTitles(wrap('<section><p class="t-h10">不是标题</p></section>'))).toEqual([
      null,
    ])
    expect(
      readSlideTitles(wrap('<section><p class="lead t-h1 dark">是标题</p></section>')),
    ).toEqual(['是标题'])
  })

  it('元素里的标签去掉 —— Four<br>Stops 是一个标题', () => {
    expect(readSlideTitles(wrap('<section><p class="t-h1">Four<br>Stops</p></section>'))).toEqual([
      'Four Stops',
    ])
  })

  it('退到 h1 / h2', () => {
    expect(readSlideTitles(wrap('<section><h2>普通标题</h2></section>'))).toEqual(['普通标题'])
  })

  it('实在没有就给 null,不编一个出来', () => {
    expect(readSlideTitles(wrap('<section><div class="s-dot"></div></section>'))).toEqual([null])
  })

  it('长句截断 —— 页胶片一行放不下', () => {
    const long = '很长的标题'.repeat(20)
    const title = readSlideTitles(wrap(`<section><p class="t-h1">${long}</p></section>`))[0]!
    expect(title.length).toBeLessThanOrEqual(41)
    expect(title.endsWith('…')).toBe(true)
  })

  it('每页一条,和页数对得上;嵌套子页不各算一条', () => {
    const html = wrap(
      '<section><p class="t-h1">一</p></section>' +
        '<section><section><p class="t-h1">二a</p></section></section>',
    )
    expect(readSlideTitles(html)).toHaveLength(2)
    expect(countTopLevelSections(html)).toBe(2)
  })

  it('不是 reveal 稿就是空的', () => {
    expect(readSlideTitles('<p>hi</p>')).toEqual([])
  })
})

describe('readPageTypes', () => {
  it('读出每一页声明的类型', () => {
    const html =
      '<div class="slides">' +
      '<section data-page="cover"><p>封面</p></section>' +
      '<section data-auto-animate data-page="bars"><p>图</p></section>' +
      '</div>'
    expect(readPageTypes(html)).toEqual(['cover', 'bars'])
  })

  it('没标的是 null —— 不猜。标错会同时误导校验、agent 和转场规划', () => {
    const html =
      '<div class="slides"><section data-page="cover">1</section><section>2</section></div>'
    expect(readPageTypes(html)).toEqual(['cover', null])
  })

  it('只认 section 上的 —— 页内元素带同名属性不算', () => {
    const html = '<div class="slides"><section><p data-page="cover">x</p></section></div>'
    expect(readPageTypes(html)).toEqual([null])
  })

  it('页数和页胶片对得上 —— 嵌套子页不算一页', () => {
    const html =
      '<div class="slides">' +
      '<section data-page="cover">1</section>' +
      '<section><section data-page="list">2a</section></section>' +
      '</div>'
    expect(readPageTypes(html)).toHaveLength(2)
  })
})
