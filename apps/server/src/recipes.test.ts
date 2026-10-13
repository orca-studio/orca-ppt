import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentSlots, frontmatter, listRecipes, pageRange, recipeEntry } from './recipes.js'

const recipe = (id: string, extra = '') => `---
id: ${id}
title: 电影级回顾片尾
mode: 汇报稿
summary: 回顾整份稿子: 再滚名单
${extra}---

# 正文
`

describe('listRecipes', () => {
  it('读 frontmatter,带上提示词;样片由缓存负责,这里不给', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    await mkdir(join(skill, 'recipes/recap-credits'), { recursive: true })
    await writeFile(join(skill, 'recipes/recap-credits/RECIPE.md'), recipe('recap-credits'))
    const [item, ...rest] = await listRecipes(skill)
    expect(rest).toHaveLength(0)
    expect(item).toMatchObject({ id: 'recap-credits', title: '电影级回顾片尾', mode: '汇报稿' })
    expect(item?.summary).toBe('回顾整份稿子: 再滚名单')
    expect(item?.preview).toBeUndefined()
    expect(item?.poster).toBeUndefined()
    expect(item?.prompt).toContain('recipes/recap-credits/RECIPE.md')
  })

  it('id 和目录名对不上、缺 frontmatter 的不进列表', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    await mkdir(join(skill, 'recipes/a'), { recursive: true })
    await mkdir(join(skill, 'recipes/b'), { recursive: true })
    await writeFile(join(skill, 'recipes/a/RECIPE.md'), recipe('not-a'))
    await writeFile(join(skill, 'recipes/b/RECIPE.md'), '# 没有 frontmatter')
    expect(await listRecipes(skill)).toEqual([])
  })

  it('没有 skill 或没有 recipes 目录时是空的', async () => {
    expect(await listRecipes(undefined)).toEqual([])
    expect(await listRecipes(await mkdtemp(join(tmpdir(), 'recipes-')))).toEqual([])
  })
})

describe('recipeEntry', () => {
  it('只给认得的同款,而且要有样稿', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    await mkdir(join(skill, 'recipes/recap-credits'), { recursive: true })
    await writeFile(join(skill, 'recipes/recap-credits/RECIPE.md'), recipe('recap-credits'))
    expect(await recipeEntry(skill, 'recap-credits')).toBeUndefined()
    await writeFile(join(skill, 'recipes/recap-credits/index.html'), '')
    expect((await recipeEntry(skill, 'recap-credits'))?.entry).toBe(
      join(skill, 'recipes/recap-credits/index.html'),
    )
    expect(await recipeEntry(skill, '../recipes/recap-credits')).toBeUndefined()
  })
})

describe('同款的顺序', () => {
  it('order 大的在前(新上架的排第一),没写的排后面', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    for (const [id, order] of [
      ['a', ''],
      ['b', 'order: 2\n'],
      ['c', 'order: 1\n'],
    ]) {
      await mkdir(join(skill, 'recipes', id!), { recursive: true })
      await writeFile(
        join(skill, 'recipes', id!, 'RECIPE.md'),
        `---\nid: ${id}\ntitle: ${id}\n${order}---\n`,
      )
    }
    expect((await listRecipes(skill)).map((item) => item.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('recipeEntry 的 sample', () => {
  it('指向 skill 里现成的示例,不复制一份', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    await mkdir(join(skill, 'recipes/drink'), { recursive: true })
    await mkdir(join(skill, 'examples/drink'), { recursive: true })
    await writeFile(join(skill, 'examples/drink/index.html'), '')
    await writeFile(
      join(skill, 'recipes/drink/RECIPE.md'),
      '---\nid: drink\ntitle: 产品分栏\nsample: ../../examples/drink\n---\n',
    )
    const found = await recipeEntry(skill, 'drink')
    expect(found?.entry).toBe(join(await realpath(skill), 'examples/drink/index.html'))
  })

  it('sample 跑出 skill 目录就不认', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    const outside = await mkdtemp(join(tmpdir(), 'outside-'))
    await writeFile(join(outside, 'index.html'), '')
    await mkdir(join(skill, 'recipes/x'), { recursive: true })
    await writeFile(
      join(skill, 'recipes/x/RECIPE.md'),
      `---\nid: x\ntitle: X\nsample: ${outside}\n---\n`,
    )
    expect(await recipeEntry(skill, 'x')).toBeUndefined()
  })
})

describe('pageRange', () => {
  it('页号从 1 数、含两头,转成下标', () => {
    expect(pageRange('4-5')).toEqual({ from: 3, to: 4 })
    expect(pageRange('2 - 2')).toEqual({ from: 1, to: 1 })
  })

  it('写错了就录整份,不猜', () => {
    expect(pageRange(undefined)).toBeUndefined()
    expect(pageRange('5-4')).toBeUndefined()
    expect(pageRange('0-3')).toBeUndefined()
    expect(pageRange('last')).toBeUndefined()
  })
})

describe('frontmatter', () => {
  it('不认的行跳过,空值不收', () => {
    expect(frontmatter('---\nid: x\n# 注释\nempty:\n---\n')).toEqual({ id: 'x' })
  })
})

describe('contentSlots', () => {
  it('取「内容槽位」表的第一列,去掉加粗和给 agent 看的属性名', () => {
    const text = `## 内容槽位

| 槽位 | 从哪取 | 缺了怎么办 |
| --- | --- | --- |
| **节点**（年份、版本号） | 用户给的 | 停下来要 |
| **回顾范围**（\`data-recap="起-止"\`） | 默认整份 | — |

## 页面结构

| 不是 | 槽位 |
| --- | --- |
| x | y |
`
    expect(contentSlots(text)).toEqual(['节点（年份、版本号）', '回顾范围'])
  })

  it('没有这一节就是空的', () => {
    expect(contentSlots('# 正文')).toEqual([])
  })
})
