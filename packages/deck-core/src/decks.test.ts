import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  countTopLevelSections,
  deckRevision,
  readPageTypes,
  readSlideTexts,
  readSlideTitles,
} from './decks.js'
import { applyTextEdit } from './edit.js'

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
  it('跳过跨页共享的锚和每页都有的固定字 —— 环形时间轴的年份、圆心的「发展历程」不是标题', () => {
    const page = (year: string, title: string) =>
      `<section><p data-id="y${year}" class="t-h1">${year}</p><p class="t-h1">发展历程</p><p class="t-h1">${title}</p></section>`
    expect(
      readSlideTitles(wrap(page('2021', '起步') + page('2022', '扩张') + page('2023', '上市'))),
    ).toEqual(['起步', '扩张', '上市'])
  })

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

describe('readSlideTexts', () => {
  const wrap = (sections: string) => `<div class="slides">${sections}</div>`

  it('按页、按源码顺序给出每一段文字,脚本样式注释里的不算', () => {
    const html = wrap(
      '<section><h1>Studio placeholder</h1><!-- 注释 --><p>第二段<br>第三段</p>' +
        '<script>let a = 1 > 0</script><style>p{}</style></section>' +
        '<section><div class="s-dot"></div></section>',
    )
    expect(readSlideTexts(html)).toEqual([['Studio placeholder', '第二段', '第三段'], []])
  })

  it('读出来的原文原样交给 edit_text 一定定位得上 —— 转义过的也一样', () => {
    const html = wrap('<section><p>R&amp;D 投入 &lt; 10%</p></section>')
    const [[text]] = readSlideTexts(html) as [[string]]
    expect(text).toBe('R&D 投入 < 10%')
    const result = applyTextEdit(html, { slide: 0, oldText: text, newText: '研发投入' })
    expect(result.ok).toBe(true)
  })
})

describe('deckRevision', () => {
  async function deck(html: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-rev-'))
    await writeFile(join(root, 'index.html'), html)
    return root
  }

  it('内容不变,版本号就不变', async () => {
    const root = await deck('<div class="slides"><section>a</section></div>')
    expect(await deckRevision(root)).toBe(await deckRevision(root))
  })

  it('成品改了一个字,版本号就变', async () => {
    const root = await deck('<div class="slides"><section>a</section></div>')
    const before = await deckRevision(root)
    await writeFile(join(root, 'index.html'), '<div class="slides"><section>b</section></div>')
    expect(await deckRevision(root)).not.toBe(before)
  })

  it('阶段产物改了也算', async () => {
    const root = await deck('<div class="slides"><section>a</section></div>')
    await mkdir(join(root, '.deck'))
    await writeFile(join(root, '.deck/plan.json'), '{"transitions":[]}')
    const before = await deckRevision(root)
    await writeFile(join(root, '.deck/plan.json'), '{"transitions":[{}]}')
    expect(await deckRevision(root)).not.toBe(before)
  })

  it('assets 里换了一张图也算 —— 观众看到的变了', async () => {
    const root = await deck('<div class="slides"><section>a</section></div>')
    await mkdir(join(root, 'assets/img'), { recursive: true })
    await writeFile(join(root, 'assets/img/cover.png'), 'v1')
    const before = await deckRevision(root)
    await writeFile(join(root, 'assets/img/cover.png'), 'v2')
    expect(await deckRevision(root)).not.toBe(before)
  })

  it('素材改了又改回去,版本号也回得去 —— 按内容算,不按修改时间', async () => {
    const root = await deck('<div class="slides"><section>a</section></div>')
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets/a.png'), 'v1')
    const original = await deckRevision(root)
    await writeFile(join(root, 'assets/a.png'), 'v2')
    await writeFile(join(root, 'assets/a.png'), 'v1')
    expect(await deckRevision(root)).toBe(original)
  })

  it('还没出稿的目录也有版本号', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-rev-'))
    expect(await deckRevision(root)).toMatch(/^[0-9a-f]{16}$/)
  })
})
