import { describe, expect, it } from 'vitest'
import { axisValues, facetsOf, sectionsOf, withTag } from './facets.js'

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

describe('sectionsOf', () => {
  const theme = (name: string, use: string[] = [], style: string[] = []) => ({
    name,
    tags: { use, style },
  })

  it('同一个条目在分区里再出现一次 —— 这正是分面区别于分类的地方', () => {
    const items = [theme('a', ['最近使用']), theme('b')]
    const sections = sectionsOf(items, ['use'], '全部主题')
    expect(sections.map((s) => s.value)).toEqual(['最近使用', '全部主题'])
    expect(sections[0]!.items.map((i) => i.name)).toEqual(['a'])
    // a 在「全部主题」里又出现一次
    expect(sections[1]!.items.map((i) => i.name)).toEqual(['a', 'b'])
  })

  it('没人带那个轴时不留一条空分区', () => {
    const sections = sectionsOf([theme('a')], ['use'], '全部主题')
    expect(sections.map((s) => s.value)).toEqual(['全部主题'])
  })

  it('多个轴按顺序各自产生分区', () => {
    const items = [theme('a', ['最近使用'], ['衬线']), theme('b', [], ['衬线'])]
    expect(sectionsOf(items, ['use', 'style']).map((s) => s.value)).toEqual(['最近使用', '衬线'])
  })

  it('兜底分区保证每个条目至少露一次 —— 标签再不全,人也不该找不到东西', () => {
    const sections = sectionsOf([theme('a'), theme('b')], ['use'], '全部主题')
    expect(sections[0]!.items).toHaveLength(2)
  })

  it('一个条目都没有时不留兜底分区', () => {
    expect(sectionsOf([], ['use'], '全部主题')).toEqual([])
  })
})
