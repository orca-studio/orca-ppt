import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkDeck, type Spec } from './spec-check.js'

// 规范数字读仓库里 skill 的那一份 —— 测试和产品用同一个来源
const spec = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../skills/orca-ppt/runtime/spec.json', import.meta.url)),
    'utf8',
  ),
) as Spec

const deck = (...sections: string[]) => `<div class="slides">${sections.join('')}</div>`
const msgs = (html: string, types: Array<string | null>) =>
  checkDeck(html, types, spec).map((issue) => issue.message)

describe('读不到规范', () => {
  it('没有 spec.json 时不做坐标检查,不自己编一份', () => {
    const html = deck('<section><p class="t-h1" style="left:80px; top:200px;">x</p></section>')
    expect(checkDeck(html, [null], undefined)).toEqual([])
  })
})

describe('安全区', () => {
  it('越过左边界要报', () => {
    const html = deck('<section><p class="t-h1" style="left:80px; top:200px;">x</p></section>')
    expect(msgs(html, [null]).join()).toContain('左安全区')
  })

  it('右边超出也报 —— 靠 left + width,不是只看 left', () => {
    const html = deck(
      '<section><div class="s-surface" style="left:1200px; top:200px; width:800px; height:200px;"></div></section>',
    )
    expect(msgs(html, [null]).join()).toContain('右安全区')
  })

  it('铺满整页的形状不算越界 —— 「整页 ↔ 卡片」那组转场靠它', () => {
    const html = deck(
      '<section><div class="s-surface" style="left:0px; top:0px; width:1920px; height:1080px;"></div></section>',
    )
    expect(msgs(html, [null])).toEqual([])
  })

  it('比画布还大的形状也是整页形状 —— 环形时间轴的扇形圆心贴边、故意出血', () => {
    const wedge = `<div class="s-accent" style="left:-460px; top:-40px; width:1160px; height:1160px;"></div>`
    expect(msgs(deck(`<section>${wedge}</section>`), [null])).toEqual([])
  })

  it('镂空聚焦的圈不算 —— 它按被聚焦的东西定位,算越界是误报', () => {
    const html = deck(
      '<section><div class="s-spot" style="left:60px; top:900px; width:400px; height:400px;"></div></section>',
    )
    expect(msgs(html, [null])).toEqual([])
  })

  it('没标类型的页也做通用检查 —— 安全区跟类型无关', () => {
    const html = deck('<section><p class="t-h1" style="left:0px; top:200px;">x</p></section>')
    expect(msgs(html, [null])).toHaveLength(1)
  })

  it('页码对得上 —— 报第几页不能错', () => {
    const html = deck(
      '<section><p style="left:200px; top:200px;">ok</p></section>',
      '<section><p style="left:40px; top:200px;">bad</p></section>',
    )
    expect(checkDeck(html, [null, null], spec)[0]?.slide).toBe(1)
  })
})

describe('横向条形图页', () => {
  const bar = (left: number, width: number, extra = '') =>
    `<div class="s-surface" data-enter="grow-right" ${extra} style="left:${left}px; top:240px; width:${width}px; height:56px;"></div>`

  it('最长的那条没写 data-id="axis" 要报 —— 下一页的轴从它变过来', () => {
    const html = deck(`<section>${bar(680, 880)}${bar(680, 400)}</section>`)
    expect(msgs(html, ['bars']).join()).toContain('axis')
  })

  it('写了就不报', () => {
    const html = deck(`<section>${bar(680, 880, 'data-id="axis"')}${bar(680, 400)}</section>`)
    expect(msgs(html, ['bars'])).toEqual([])
  })

  it('条的 left 和高是写死的', () => {
    const html = deck(`<section>${bar(240, 880, 'data-id="axis"')}</section>`)
    expect(msgs(html, ['bars']).join()).toContain('left 应为 680')
  })

  it('超过 6 条要报', () => {
    const bars = Array.from({ length: 7 }, (_, i) => bar(680, 880 - i)).join('')
    expect(msgs(deck(`<section>${bars}</section>`), ['bars']).join()).toContain('最多 6 条')
  })

  it('一条都没有也要报 —— 标成条形图却没有条', () => {
    expect(
      msgs(deck('<section><p style="left:200px; top:200px;">x</p></section>'), ['bars']).join(),
    ).toContain('一条')
  })
})

describe('画外待命', () => {
  it('整个在画布外、别的页有配对的元素不算越界', () => {
    const html = deck(
      '<section><div data-id="focus" class="s-accent" style="left:-640px; top:240px; width:520px; height:112px;"></div></section>',
      '<section><div data-id="focus" class="s-accent" style="left:120px; top:240px; width:520px; height:112px;"></div></section>',
    )
    expect(msgs(html, [null, null])).toEqual([])
  })

  it('没有配对、或只露出一部分的照样报', () => {
    const lone = deck(
      '<section><div data-id="x" class="s-accent" style="left:-640px; top:240px; width:520px; height:112px;"></div></section>',
    )
    expect(msgs(lone, [null]).join()).toContain('左安全区')
    const partly = deck(
      '<section><div data-id="y" class="s-accent" style="left:-100px; top:240px; width:520px; height:112px;"></div></section>',
      '<section><div data-id="y" class="s-accent" style="left:120px; top:240px; width:520px; height:112px;"></div></section>',
    )
    expect(msgs(partly, [null, null]).join()).toContain('左安全区')
  })
})

describe('横向时间线页', () => {
  const dot = (left: number) =>
    `<div class="s-dot" style="left:${left}px; top:542px; width:40px; height:40px;"></div>`

  it('四个节点落在四列上就通过', () => {
    const html = deck(`<section>${[120, 560, 1000, 1440].map(dot).join('')}</section>`)
    expect(msgs(html, ['timeline'])).toEqual([])
  })

  it('节点不在四列上要报 —— Bento 也用这四列,两页之间才接得上', () => {
    const html = deck(`<section>${[120, 600, 1000, 1440].map(dot).join('')}</section>`)
    expect(msgs(html, ['timeline']).join()).toContain('600')
  })

  it('第五站也要报 —— 规范只放 4 站,第五站的标签会挤出右边安全区', () => {
    const html = deck(`<section>${[120, 560, 1000, 1440, 1440].map(dot).join('')}</section>`)
    expect(msgs(html, ['timeline']).join()).toContain('5 个节点')
  })

  it('节点数不对要报 —— 规范是 4 个', () => {
    const html = deck(`<section>${[120, 560, 1000].map(dot).join('')}</section>`)
    expect(msgs(html, ['timeline']).join()).toContain('3 个节点')
  })
})

describe('Bento 网格页', () => {
  const cell = (left: number, top: number) =>
    `<div class="s-surface" style="left:${left}px; top:${top}px; width:360px; height:360px;"></div>`

  it('格子落在格位上就通过', () => {
    const html = deck(`<section>${cell(120, 240)}${cell(560, 640)}</section>`)
    expect(msgs(html, ['bento'])).toEqual([])
  })

  it('格子不在格位上要报', () => {
    expect(msgs(deck(`<section>${cell(200, 240)}</section>`), ['bento']).join()).toContain('200')
  })

  it('一个格子都没有要报 —— 标成 Bento 却不是网格', () => {
    const html = deck('<section><p style="left:200px; top:200px;">x</p></section>')
    expect(msgs(html, ['bento']).join()).toContain('没有 360×360')
  })
})

describe('对比页', () => {
  const panel = (left: number) =>
    `<div class="s-surface" style="left:${left}px; top:240px; width:800px; height:760px;"></div>`

  it('两个面板在 120 和 1000 就通过', () => {
    expect(msgs(deck(`<section>${panel(120)}${panel(1000)}</section>`), ['compare'])).toEqual([])
  })

  it('只有一个面板要报 —— 对比页得有两侧', () => {
    expect(msgs(deck(`<section>${panel(120)}</section>`), ['compare']).join()).toContain('1 个')
  })
})
