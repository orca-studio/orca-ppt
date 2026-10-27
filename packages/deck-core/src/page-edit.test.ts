import { describe, expect, it } from 'vitest'
import {
  changedPages,
  editPages,
  readPage,
  replaceImage,
  sourcePages,
  writePage,
} from './page-edit.js'

const a = '<section id="a"><h2>A</h2></section>'
const b = '<SECTION data-page="cover"><h2>B</h2></SECTION>'
const c =
  '<section><img id="photo" src="assets/a.png" style="width:100px" data-id="carry"></section>'
const deck = `<div class="slides">\n${a}\n<!-- retain -->\n${b}\n${c}\n</div><script>const fake = '<section>fake</section>';</script>`

describe('source page edits', () => {
  it('moves whole source ranges and keeps script/comments/case unchanged', () => {
    const moved = editPages(deck, { action: 'move', index: 0, to: 2 })
    expect(moved.order).toEqual([1, 2, 0])
    expect(moved.html).toBe(deck.replace(a, b).replace(b + '\n' + c, c + '\n' + a))
    expect(sourcePages(moved.html).pages).toHaveLength(3)
  })
  it('inserts at every boundary, escapes titles and preserves old source', () => {
    for (const index of [0, 1, 3]) {
      const added = editPages(deck, { action: 'insert', index, title: '<hello> & "quoted"' })
      expect(added.order[index]).toBe(null)
      expect(sourcePages(added.html).pages).toHaveLength(4)
      expect(added.html).toContain('&lt;hello&gt; &amp; &quot;quoted&quot;')
      for (const source of [a, b, c]) expect(added.html).toContain(source)
    }
  })
  it('deletes the last section without losing closing wrappers/scripts', () => {
    expect(editPages(deck, { action: 'delete', index: 2 }).html).toBe(deck.replace(c, ''))
  })
  it('refuses missing/invalid/nested pages and deleting the last page', () => {
    expect(() => editPages(deck, { action: 'move', index: 0, to: 3 })).toThrow('目标页号')
    expect(() => editPages(deck, { action: 'delete', index: 3 })).toThrow('页号')
    expect(() =>
      editPages(`<div class="slides">${a}</div>`, { action: 'delete', index: 0 }),
    ).toThrow('至少保留')
    expect(() =>
      sourcePages('<div class="slides"><section><section>x</section></section></div>'),
    ).toThrow('嵌套')
    expect(() => sourcePages('<div class="slides"><section>x</div>')).toThrow('不完整')
  })
  it('renumbers surviving adjacent transitions and removes invalid pairs from comments', () => {
    const html = `<!-- 版式\n转场计划\n1→2 关系: A→B\n2→3 关系: B→C\n-->${deck}`
    const moved = editPages(html, { action: 'move', index: 0, to: 2 })
    expect(moved.html).toContain('1→2 关系: B→C')
    expect(moved.html).not.toContain('关系: A→B')
    expect(moved.html).toContain('--><div')
    expect(moved.remap(1, 2)).toEqual([0, 1])
    expect(moved.remap(0, 1)).toBeNull()
  })
})

describe('image source edits', () => {
  it('only replaces src and preserves style/carry/source bytes', () => {
    expect(replaceImage(deck, 2, '#photo', 'assets/a.png', 'assets/b.png')).toBe(
      deck.replace('src="assets/a.png"', 'src="assets/b.png"'),
    )
  })
  it('supports anchors and refuses ambiguous, stale and runtime-only selectors', () => {
    const anchored = deck.replace('id="photo"', 'data-anchor="photo"')
    expect(replaceImage(anchored, 2, '[data-anchor="photo"]', 'assets/a.png', 'b.png')).toContain(
      'src="b.png"',
    )
    expect(() => replaceImage(deck, 2, '#photo', 'old.png', 'b.png')).toThrow('已变化')
    expect(() => replaceImage(deck, 2, 'img:nth-child(1)', 'assets/a.png', 'b.png')).toThrow(
      '运行时',
    )
    expect(() =>
      replaceImage(
        deck.replace(c, c + '<img id="photo" src="assets/a.png">'),
        2,
        '#photo',
        'assets/a.png',
        'b.png',
      ),
    ).not.toThrow()
    const duplicate = deck.replace(
      c,
      c.replace('</section>', '<img id="photo" src="assets/a.png"></section>'),
    )
    expect(() => replaceImage(duplicate, 2, '#photo', 'assets/a.png', 'b.png')).toThrow('唯一')
    expect(() =>
      replaceImage(
        deck.replace('style="width:100px"', 'srcset="assets/c.png 2x"'),
        2,
        '#photo',
        'assets/a.png',
        'b.png',
      ),
    ).toThrow('srcset')
  })
})

describe('按页读写', () => {
  it('读出那一页的原文,大小写和属性原样', () => {
    expect(readPage(deck, 1)).toEqual({ html: b, count: 3 })
    expect(() => readPage(deck, 3)).toThrow('页号')
  })
  it('整页换掉一页,页外一个字不动', () => {
    const page = '<section data-page="cover"><h2>新的 B</h2></section>'
    expect(writePage(deck, 1, `  ${page}\n`)).toBe(deck.replace(b, page))
  })
  it('不是恰好一个 section、嵌套页面、没闭合好会伤到别的页的,一律拒绝', () => {
    expect(() => writePage(deck, 0, '<div>x</div>')).toThrow('<section>')
    expect(() => writePage(deck, 0, '<section>1</section><section>2</section>')).toThrow(
      '<section>',
    )
    expect(() => writePage(deck, 0, '<section><section>x</section></section>')).toThrow('嵌套')
    expect(() => writePage(deck, 0, '<section><div>x</section>')).not.toThrow()
    expect(() => writePage(deck, 0, '<section><template>x</section>')).toThrow('闭合')
  })
})

describe('两版只差在哪几页', () => {
  it('只改了一页就只给那一页', () => {
    const page = '<section id="a"><h2>A2</h2></section>'
    expect(changedPages(deck, deck.replace(a, page))).toEqual([{ index: 0, html: page }])
  })
  it('只改了页外的注释(转场计划):一页都不用换', () => {
    expect(changedPages(deck, deck.replace('<!-- retain -->', '<!-- 转场计划 1→2 -->'))).toEqual([])
    expect(changedPages(deck, deck.replace('<!-- retain -->', ''))).toEqual([])
  })
  it('页数变了、页外的东西变了,交给整份重载', () => {
    expect(changedPages(deck, deck.replace(c, ''))).toBeUndefined()
    expect(changedPages(deck, deck.replace('const fake', 'const real'))).toBeUndefined()
    expect(changedPages(deck, '<div>不成样子')).toBeUndefined()
  })
})
