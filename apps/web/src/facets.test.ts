import { describe, expect, it } from 'vitest'
import { sectionsOf } from './facets.js'

const item = (name: string, tags: string[] = []) => ({ name, tags })

describe('sectionsOf', () => {
  it('同一个条目在分区和兜底区各出现一次 —— 这正是分区区别于分类的地方', () => {
    const a = item('a', ['business'])
    const b = item('b', ['business'])
    const sections = sectionsOf([a, b], { fallback: '全部主题' })
    expect(sections.map((s) => s.title)).toEqual(['business', '全部主题'])
    expect(sections[0]!.items).toEqual([a, b])
    expect(sections[1]!.items).toEqual([a, b])
  })

  it('只有一个成员的标签不成区 —— 大部分模板只有一个标签,门槛给 1 会出来一堆单卡区', () => {
    const sections = sectionsOf([item('a', ['business']), item('b', ['creative'])], {
      fallback: '全部主题',
    })
    expect(sections.map((s) => s.title)).toEqual(['全部主题'])
  })

  it('门槛可以调 —— 条目多了之后分区自己长出来', () => {
    const sections = sectionsOf([item('a', ['business'])], { fallback: '全部', min: 1 })
    expect(sections.map((s) => s.title)).toEqual(['business', '全部'])
  })

  it('派生分区排最前,而且不从 tags 里读 —— 它不是标签', () => {
    const a = item('a', ['business'])
    const sections = sectionsOf([a, item('b')], {
      derived: [{ title: '最近使用', items: [a] }],
      fallback: '全部主题',
    })
    expect(sections.map((s) => s.title)).toEqual(['最近使用', '全部主题'])
    expect(sections[0]!.items).toEqual([a])
  })

  it('空的派生分区不显示 —— 没用过的时候不该留一条空标题', () => {
    const sections = sectionsOf([item('a')], {
      derived: [{ title: '最近使用', items: [] }],
      fallback: '全部主题',
    })
    expect(sections.map((s) => s.title)).toEqual(['全部主题'])
  })

  it('分区标题用词表里的 label,不是 id', () => {
    const sections = sectionsOf([item('a', ['business']), item('b', ['business'])], {
      fallback: '全部',
      label: (tag) => (tag === 'business' ? '商业' : tag),
    })
    expect(sections[0]!.title).toBe('商业')
  })

  it('兜底区保证每个条目至少露一次 —— 标签再不全,人也不该找不到东西', () => {
    const sections = sectionsOf([item('a'), item('b')], { fallback: '全部主题' })
    expect(sections[0]!.items).toHaveLength(2)
  })

  it('一个条目都没有时什么区都不给', () => {
    expect(sectionsOf([], { fallback: '全部主题' })).toEqual([])
  })
})
