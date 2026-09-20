import { describe, expect, it } from 'vitest'
import { axisValues, hasTag, tagAttr, tagLine } from './tags.js'

describe('tagLine', () => {
  const head = `/* 主题：Editorial Forest（取自别处）
 * 场景：年度复盘 / 研究汇报
 * 风格：沉静 · 衬线 · 读物感
 * 在 tokens.css 之后引入。*/`

  it('一行拆成一组标签', () => {
    expect(tagLine(head, '场景')).toEqual(['年度复盘', '研究汇报'])
    expect(tagLine(head, '风格')).toEqual(['沉静', '衬线', '读物感'])
  })

  it('几种分隔符都认 —— 这行是人手写的,为一个顿号漏掉半行不值得', () => {
    expect(tagLine(' * 场景：路演、年鉴,复盘 / 分享', '场景')).toEqual([
      '路演',
      '年鉴',
      '复盘',
      '分享',
    ])
  })

  it('注释的星号不会混进标签里', () => {
    expect(tagLine(' * 场景：产品发布 / 方案提案\n * 风格：明快', '场景')).toEqual([
      '产品发布',
      '方案提案',
    ])
  })

  it('全角半角冒号都认', () => {
    expect(tagLine(' * 风格: 明快', '风格')).toEqual(['明快'])
  })

  it('没有这一行就是空,不报错也不编一个', () => {
    expect(tagLine('/* 主题：无标签 */', '场景')).toEqual([])
  })
})

describe('tagAttr', () => {
  it('空格分隔,一份稿子可以有好几个页型', () => {
    expect(tagAttr('<html lang="zh" data-tags="bento 时间线 条形图">')).toEqual([
      'bento',
      '时间线',
      '条形图',
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

describe('hasTag', () => {
  it('认轴,不是在所有标签里乱找', () => {
    const tags = { mode: ['standard'], page: ['bento'] }
    expect(hasTag(tags, 'page', 'bento')).toBe(true)
    expect(hasTag(tags, 'mode', 'bento')).toBe(false)
  })

  it('没有这个轴时是 false,不抛', () => {
    expect(hasTag({}, 'page', 'bento')).toBe(false)
  })
})

describe('axisValues', () => {
  it('把某个轴上出现过的标签收齐 —— 这就是筛选条,不用另外维护一张表', () => {
    const items = [
      { tags: { page: ['bento', '时间线'] } },
      { tags: { page: ['bento'] } },
      { tags: { page: ['整页视频'] } },
    ]
    expect(axisValues(items, 'page')).toEqual(['bento', '时间线', '整页视频'])
  })

  it('按第一次出现的顺序,不排序 —— 顺序是作者定的', () => {
    expect(axisValues([{ tags: { a: ['z', 'a'] } }], 'a')).toEqual(['z', 'a'])
  })

  it('没人带这个轴时是空', () => {
    expect(axisValues([{ tags: { page: ['bento'] } }], 'mode')).toEqual([])
  })
})
