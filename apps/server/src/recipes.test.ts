import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { frontmatter, listRecipes, pageRange, recipeEntry } from './recipes.js'

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
