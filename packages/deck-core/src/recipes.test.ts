import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contentSlots, frontmatter, listRecipes, recipeEntry } from './recipes.js'

const recipe = (id: string, extra = '') => `---
id: ${id}
title: 电影级回顾片尾
mode: 汇报稿
summary: 回顾整份稿子: 再滚名单
${extra}---

# 正文
`

describe('listRecipes', () => {
  it('读 frontmatter,带上提示词', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    await mkdir(join(skill, 'recipes/recap-credits'), { recursive: true })
    await writeFile(join(skill, 'recipes/recap-credits/RECIPE.md'), recipe('recap-credits'))
    const [item, ...rest] = await listRecipes(skill)
    expect(rest).toHaveLength(0)
    expect(item).toMatchObject({ id: 'recap-credits', title: '电影级回顾片尾', mode: '汇报稿' })
    expect(item?.summary).toBe('回顾整份稿子: 再滚名单')
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

  it('frontmatter 的 poster 指向配方目录里的封面图:文件在才给', async () => {
    const skill = await realpath(await mkdtemp(join(tmpdir(), 'recipes-')))
    await mkdir(join(skill, 'recipes/a'), { recursive: true })
    await mkdir(join(skill, 'recipes/b'), { recursive: true })
    await writeFile(join(skill, 'recipes/a/RECIPE.md'), recipe('a', 'poster: cover.jpg\n'))
    await writeFile(join(skill, 'recipes/a/cover.jpg'), 'jpg')
    await writeFile(join(skill, 'recipes/b/RECIPE.md'), recipe('b', 'poster: missing.jpg\n'))
    const byId = Object.fromEntries((await listRecipes(skill)).map((r) => [r.id, r]))
    expect(byId.a?.poster).toBe(join(skill, 'recipes/a/cover.jpg'))
    expect(byId.b?.poster).toBeUndefined()
  })

  it('内置的每个同款和案例都带封面图:首页不现录样片,没有封面卡片就是空的', async () => {
    const skill = fileURLToPath(new URL('../../../skills/orca-ppt', import.meta.url))
    const missing = (await listRecipes(skill)).filter((item) => !item.poster).map((item) => item.id)
    // 补法:node skills/orca-ppt/scripts/render-poster.mjs recipes/<id>
    expect(missing).toEqual([])
  })

  it('没有 skill 或没有 recipes 目录时是空的', async () => {
    expect(await listRecipes(undefined)).toEqual([])
    expect(await listRecipes(await mkdtemp(join(tmpdir(), 'recipes-')))).toEqual([])
  })
})

const example = (id: string, extra = '') => `---
id: ${id}
title: 人物生平介绍
${extra}---
`

describe('案例', () => {
  it('examples/<id>/EXAMPLE.md 进列表:kind 是 example,没有做同款的提示词', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    await mkdir(join(skill, 'examples/ink-portrait'), { recursive: true })
    await writeFile(join(skill, 'examples/ink-portrait/EXAMPLE.md'), example('ink-portrait'))
    const [item] = await listRecipes(skill)
    expect(item).toMatchObject({ kind: 'example', id: 'ink-portrait', title: '人物生平介绍' })
    expect(item?.prompt).toBeUndefined()
  })

  it('已经被同款的 sample 指着、或和同款撞了 id 的不再单列;_assets 不算', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    await mkdir(join(skill, 'recipes/drink'), { recursive: true })
    await writeFile(
      join(skill, 'recipes/drink/RECIPE.md'),
      recipe('drink', 'sample: ../../examples/showcase\n'),
    )
    for (const id of ['showcase', 'drink', '_assets', 'solo']) {
      await mkdir(join(skill, 'examples', id), { recursive: true })
      await writeFile(join(skill, 'examples', id, 'EXAMPLE.md'), example(id))
    }
    const items = await listRecipes(skill)
    expect(items.map((item) => [item.kind, item.id])).toEqual([
      ['recipe', 'drink'],
      ['example', 'solo'],
    ])
  })

  it('和同款按 order 一起排', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    await mkdir(join(skill, 'recipes/a'), { recursive: true })
    await writeFile(join(skill, 'recipes/a/RECIPE.md'), recipe('a', 'order: 1\n'))
    await mkdir(join(skill, 'examples/b'), { recursive: true })
    await writeFile(join(skill, 'examples/b/EXAMPLE.md'), example('b', 'order: 2\n'))
    expect((await listRecipes(skill)).map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('入口是 examples/<id>/index.html', async () => {
    const skill = await mkdtemp(join(tmpdir(), 'recipes-'))
    await mkdir(join(skill, 'examples/solo'), { recursive: true })
    await writeFile(join(skill, 'examples/solo/EXAMPLE.md'), example('solo'))
    await writeFile(join(skill, 'examples/solo/index.html'), '')
    expect(await recipeEntry(skill, 'solo')).toMatchObject({
      kind: 'example',
      entry: join(skill, 'examples/solo/index.html'),
    })
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
