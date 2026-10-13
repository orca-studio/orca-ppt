import { describe, expect, it } from 'vitest'
import { applyTextEdit, escapeHtml } from './edit.js'

const deck = (...sections: string[]) => `<div class="slides">${sections.join('')}</div>`

describe('applyTextEdit', () => {
  it('只换那一段文字,标签和属性一个不动', () => {
    const html = deck(
      '<section><p data-carry="title" class="t-h1">走过的四站。</p></section>',
      '<section><p class="t-h1">别的页</p></section>',
    )
    const result = applyTextEdit(html, { slide: 0, oldText: '走过的四站。', newText: '四站,一年' })
    expect(result.ok).toBe(true)
    expect(result.ok && result.html).toContain('<p data-carry="title" class="t-h1">四站,一年</p>')
  })

  it('改的是指定那一页,别页同样的文字不动', () => {
    const html = deck('<section><p>标题</p></section>', '<section><p>标题</p></section>')
    const result = applyTextEdit(html, { slide: 1, oldText: '标题', newText: '新标题' })
    expect(result.ok && result.html).toBe(
      deck('<section><p>标题</p></section>', '<section><p>新标题</p></section>'),
    )
  })

  it('整段文字一模一样的优先 —— 「北岸软件」不撞「北岸软件 · 2021–2025」', () => {
    const html = deck('<section><p>北岸软件 · 2021–2025</p><p>北岸软件</p></section>')
    const result = applyTextEdit(html, { slide: 0, oldText: '北岸软件', newText: '南山' })
    expect(result.ok && result.html).toBe(
      deck('<section><p>北岸软件 · 2021–2025</p><p>南山</p></section>'),
    )
  })

  it('短数字也认得准 —— 「12」不撞「2021」', () => {
    const html = deck('<section><p>2021</p><p class="t-metric">12</p></section>')
    const result = applyTextEdit(html, { slide: 0, oldText: '12', newText: '30' })
    expect(result.ok && result.html).toContain('<p class="t-metric">30</p>')
  })

  it('新文字留空就删掉整个元素,连它独占的那一行', () => {
    const html = deck('<section>\n    <p>标题</p>\n    <p class="t-metric">12</p>\n  </section>')
    const result = applyTextEdit(html, { slide: 0, oldText: '12', newText: '' })
    expect(result.ok && result.html).toBe(deck('<section>\n    <p>标题</p>\n  </section>'))
  })

  it('元素里还套着别的标签就不删,只清掉那段字', () => {
    const html = deck('<section><p>12<span>人</span></p></section>')
    const result = applyTextEdit(html, { slide: 0, oldText: '12', newText: '' })
    expect(result.ok && result.html).toBe(deck('<section><p><span>人</span></p></section>'))
  })

  it('改一段字里的一部分仍然可以(退回子串匹配)', () => {
    const html = deck('<section><p>走过的四站。</p></section>')
    const result = applyTextEdit(html, { slide: 0, oldText: '四站', newText: '五站' })
    expect(result.ok && result.html).toContain('<p>走过的五站。</p>')
  })

  it('同一页里有两处一样的文字就拒绝 —— 认不准是哪一处', () => {
    const html = deck('<section><p>下一步</p><span>下一步</span></section>')
    const result = applyTextEdit(html, { slide: 0, oldText: '下一步', newText: 'x' })
    expect(result).toEqual({ ok: false, reason: '这一页里有好几处一样的文字,认不准是哪一处' })
  })

  it('找不到就拒绝 —— 稿子多半刚被改过', () => {
    const html = deck('<section><p>现在的文字</p></section>')
    const result = applyTextEdit(html, { slide: 0, oldText: '旧的文字', newText: 'x' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('找不到')
  })

  it('源码里是转义过的也认得出来,并且写回去也转义', () => {
    const html = deck('<section><p>Studio &amp; Salon</p></section>')
    const result = applyTextEdit(html, {
      slide: 0,
      oldText: 'Studio & Salon',
      newText: 'Studio & Salon 2026',
    })
    expect(result.ok && result.html).toContain('<p>Studio &amp; Salon 2026</p>')
  })

  it('新文字里的尖括号转义掉 —— 不然一次编辑就能把结构写坏', () => {
    const html = deck('<section><p>标题</p></section>')
    const result = applyTextEdit(html, { slide: 0, oldText: '标题', newText: '<script>x</script>' })
    expect(result.ok && result.html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(result.ok && result.html).not.toContain('<script>')
  })

  it('没变化就原样返回,不写盘', () => {
    const html = deck('<section><p>标题</p></section>')
    expect(applyTextEdit(html, { slide: 0, oldText: '标题', newText: ' 标题 ' })).toEqual({
      ok: true,
      html,
    })
  })

  it('页号越界如实报错', () => {
    const result = applyTextEdit(deck('<section><p>a</p></section>'), {
      slide: 5,
      oldText: 'a',
      newText: 'b',
    })
    expect(result).toEqual({ ok: false, reason: '没有第 6 页' })
  })

  it('原文是空的就拒绝 —— 没法定位', () => {
    const result = applyTextEdit(deck('<section><p>a</p></section>'), {
      slide: 0,
      oldText: '  ',
      newText: 'b',
    })
    expect(result.ok).toBe(false)
  })

  it('嵌套子页不影响页号 —— 和数页数用同一套切法', () => {
    const html = deck(
      '<section><p>一</p></section>',
      '<section><section><p>二a</p></section></section>',
      '<section><p>三</p></section>',
    )
    const result = applyTextEdit(html, { slide: 2, oldText: '三', newText: '叁' })
    expect(result.ok && result.html).toContain('<p>叁</p>')
  })
})

describe('escapeHtml', () => {
  it('只转会改变结构的那三个', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"')
  })
})
