import { describe, expect, it } from 'vitest'
import { groupTemplates, type Template } from './gallery-groups.js'

const make = (over: Partial<Template> & { id: string }): Template =>
  ({ kind: 'example', title: over.id, ...over }) as Template

describe('groupTemplates', () => {
  it('按版式族分组,顺序是定好的', () => {
    const groups = groupTemplates([
      make({ id: 'b', layout: 'bento' }),
      make({ id: 's', layout: 'story' }),
      make({ id: 'n', layout: 'standard' }),
    ])
    expect(groups.map((g) => g.title)).toEqual(['汇报稿', '故事稿', 'Bento'])
  })

  it('每组里空白排在成稿前面 —— 「从头写起」是这一类的起点', () => {
    const groups = groupTemplates([
      make({ id: 'example', layout: 'standard' }),
      make({ id: 'blank', kind: 'template', layout: 'standard' }),
    ])
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['blank', 'example'])
  })

  it('空组不显示 —— 没有故事稿时不该留一条空标题', () => {
    const groups = groupTemplates([make({ id: 'n', layout: 'standard' })])
    expect(groups).toHaveLength(1)
  })

  it('没标版式的归到「其他」,不丢也不硬塞进某一类', () => {
    const groups = groupTemplates([make({ id: 'n', layout: 'standard' }), make({ id: '?' })])
    expect(groups.map((g) => g.title)).toEqual(['汇报稿', '其他'])
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['?'])
  })

  it('全都没标版式时只有一组「其他」,不是空白一片', () => {
    expect(groupTemplates([make({ id: 'a' })]).map((g) => g.title)).toEqual(['其他'])
  })

  it('什么都没有时返回空 —— 界面自己去说「找不到 skill」', () => {
    expect(groupTemplates([])).toEqual([])
  })
})
