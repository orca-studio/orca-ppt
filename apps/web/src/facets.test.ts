import { describe, expect, it } from 'vitest'
import { axisValues, facetsOf, withTag } from './facets.js'

const deck = (id: string, mode: string[], page: string[] = []) => ({ id, tags: { mode, page } })

describe('facetsOf', () => {
  it('一个条目会出现在好几组里 —— 这正是分面和分类的区别', () => {
    const items = [deck('a', ['standard'], ['bento', '时间线'])]
    const facets = facetsOf(items, 'page')
    expect(facets.map((f) => f.value)).toEqual(['bento', '时间线'])
    expect(facets[0]!.items[0]!.id).toBe('a')
    expect(facets[1]!.items[0]!.id).toBe('a')
  })

  it('组是条目自己的标签决定的,不用另外维护一张表', () => {
    const items = [deck('a', [], ['整页视频']), deck('b', [], ['bento'])]
    expect(facetsOf(items, 'page').map((f) => f.value)).toEqual(['整页视频', 'bento'])
  })

  it('order 把想优先的标签提到前面,其余按第一次出现的顺序', () => {
    const items = [deck('a', [], ['bento']), deck('b', [], ['最近使用'])]
    expect(facetsOf(items, 'page', ['最近使用']).map((f) => f.value)).toEqual(['最近使用', 'bento'])
  })

  it('order 里没人带的标签不会凭空多出一组', () => {
    const items = [deck('a', [], ['bento'])]
    expect(facetsOf(items, 'page', ['最近使用']).map((f) => f.value)).toEqual(['bento'])
  })

  it('没人带这个轴时是空 —— 界面据此不显示这一块', () => {
    expect(facetsOf([deck('a', ['standard'])], 'page')).toEqual([])
  })

  it('不排序 —— 顺序是作者和使用决定的,字母序对人没有意义', () => {
    const items = [deck('a', [], ['z']), deck('b', [], ['a'])]
    expect(facetsOf(items, 'page').map((f) => f.value)).toEqual(['z', 'a'])
  })
})

describe('withTag', () => {
  it('带这个标签的都算,带不带别的不影响', () => {
    const items = [deck('a', ['standard'], ['bento']), deck('b', ['story'])]
    expect(withTag(items, 'mode', 'standard').map((i) => i.id)).toEqual(['a'])
    expect(withTag(items, 'page', 'bento').map((i) => i.id)).toEqual(['a'])
  })

  it('没有这个轴时是空,不抛', () => {
    expect(withTag([{ id: 'a', tags: {} }], 'page', 'bento')).toEqual([])
  })
})

describe('axisValues', () => {
  it('收齐某个轴上出现过的标签 —— 这就是筛选条,有了新标签自己就长出来', () => {
    const items = [deck('a', [], ['bento', '时间线']), deck('b', [], ['bento'])]
    expect(axisValues(items, 'page')).toEqual(['bento', '时间线'])
  })
})
