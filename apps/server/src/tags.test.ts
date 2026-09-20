import { describe, expect, it } from 'vitest'
import {
  groupByTag,
  keepKnown,
  labelOf,
  parseVocabulary,
  tagAttr,
  tagIssues,
  tagLine,
} from './tags.js'

const VOCAB = [
  { id: 'business', label: '商业' },
  { id: 'editorial', label: '社论' },
  { id: 'creative', label: '创意' },
]

describe('parseVocabulary', () => {
  it('读出 id 和 label —— 文件里写 id,界面上显示 label', () => {
    expect(parseVocabulary({ tags: [{ id: 'business', label: '商业' }] })).toEqual([
      { id: 'business', label: '商业' },
    ])
  })

  it('没写 label 就用 id —— 显示一个 ASCII 词,好过显示空白', () => {
    expect(parseVocabulary({ tags: [{ id: 'business' }] })).toEqual([
      { id: 'business', label: 'business' },
    ])
  })

  it('下划线开头的键是给人看的说明,不是词表', () => {
    expect(parseVocabulary({ _: ['说明'], tags: [{ id: 'a' }] })).toEqual([{ id: 'a', label: 'a' }])
  })

  it('坏掉的条目丢掉,不抛 —— 少一个标签不值得让应用起不来', () => {
    expect(parseVocabulary({ tags: [{ id: 'a' }, null, 'x', { label: '没有 id' }] })).toEqual([
      { id: 'a', label: 'a' },
    ])
  })

  it('整份读不出来就当空', () => {
    expect(parseVocabulary(null)).toEqual([])
    expect(parseVocabulary('nope')).toEqual([])
    expect(parseVocabulary({ tags: 'not an array' })).toEqual([])
  })
})

describe('keepKnown', () => {
  it('只留词表里认识的 —— 标签不能自由决定', () => {
    expect(keepKnown(['business', '我自己造的词'], VOCAB)).toEqual({
      kept: ['business'],
      unknown: ['我自己造的词'],
    })
  })

  it('拼错的要报出来 —— 默默接受错别字等于回到自由发挥', () => {
    expect(keepKnown(['busines'], VOCAB).unknown).toEqual(['busines'])
  })

  it('词表是空的就原样放行 —— 校验是为了抓错别字,不是缺文件时清空标签', () => {
    expect(keepKnown(['whatever'], [])).toEqual({ kept: ['whatever'], unknown: [] })
  })
})

describe('labelOf', () => {
  it('id 换成显示名', () => {
    expect(labelOf(VOCAB, 'business')).toBe('商业')
  })

  it('词表里没有就原样显示 id,不显示空白', () => {
    expect(labelOf(VOCAB, 'unknown')).toBe('unknown')
  })
})

describe('tagIssues', () => {
  it('拼错的要报', () => {
    const issues = tagIssues([{ name: 'rogue', tags: [], unknown: ['editoral'] }], VOCAB)
    expect(issues.join()).toContain('editoral')
  })

  it('一个标签都没挂的也要报 —— 上新一份模板必须挑一个', () => {
    const issues = tagIssues([{ name: 'bare', tags: [], unknown: [] }], VOCAB)
    expect(issues.join()).toContain('bare')
    // 报的时候把可选项列出来,人不用再去翻词表
    expect(issues.join()).toContain('business')
  })

  it('挂好了的不报', () => {
    expect(tagIssues([{ name: 'ok', tags: ['business'], unknown: [] }], VOCAB)).toEqual([])
  })
})

describe('tagLine', () => {
  const head = ['/* 主题：Editorial Forest', ' * 标签：editorial / creative', ' */'].join('\n')

  it('一行拆成一组标签', () => {
    expect(tagLine(head, '标签')).toEqual(['editorial', 'creative'])
  })

  it('几种分隔符都认 —— 这行是人手写的,为一个顿号漏掉半行不值得', () => {
    expect(tagLine(' * 标签：a、b,c / d', '标签')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('注释的星号不会混进标签里', () => {
    expect(tagLine(' * 标签：business\n * 一句话：明快', '标签')).toEqual(['business'])
  })

  it('全角半角冒号都认', () => {
    expect(tagLine(' * 标签: business', '标签')).toEqual(['business'])
  })

  it('没有这一行就是空', () => {
    expect(tagLine('/* 主题：没标签 */', '标签')).toEqual([])
  })
})

describe('tagAttr', () => {
  it('空格分隔,一份稿子可以有好几个', () => {
    expect(tagAttr('<html lang="zh" data-tags="business editorial">')).toEqual([
      'business',
      'editorial',
    ])
  })

  it('没有这个属性就是空', () => {
    expect(tagAttr('<html lang="zh" data-layout="standard">')).toEqual([])
  })

  it('只认 <html> 上的 —— 正文里出现同名属性不算', () => {
    expect(tagAttr('<html><div data-tags="假的"></div>')).toEqual([])
  })

  it('属性是空串时不产生一个空标签', () => {
    expect(tagAttr('<html data-tags="">')).toEqual([])
  })
})

describe('groupByTag', () => {
  const item = (name: string, tags: string[]) => ({ name, tags })

  it('同一个条目出现在它带的每个标签下', () => {
    const a = item('a', ['business', 'editorial'])
    const groups = groupByTag([a, item('b', ['business']), item('c', ['editorial'])], 1)
    expect(groups.map((g) => g.tag)).toEqual(['business', 'editorial'])
    expect(groups[0]!.items).toHaveLength(2)
    expect(groups[1]!.items).toHaveLength(2)
  })

  it('成区有门槛 —— 大部分模板只有一个标签,门槛给 1 会出来一堆单卡区', () => {
    const groups = groupByTag([item('a', ['business']), item('b', ['editorial'])])
    expect(groups).toEqual([])
  })

  it('够数了才成区', () => {
    const groups = groupByTag([item('a', ['business']), item('b', ['business'])])
    expect(groups.map((g) => g.tag)).toEqual(['business'])
  })
})
