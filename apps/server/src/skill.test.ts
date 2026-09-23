import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCatalog, resolveSkillPath } from './skill.js'

async function fakeSkill() {
  const dir = await mkdtemp(join(tmpdir(), 'skill-'))
  await writeFile(join(dir, 'SKILL.md'), '# skill')
  await mkdir(join(dir, 'runtime/themes'), { recursive: true })
  await mkdir(join(dir, 'templates/layouts'), { recursive: true })
  await writeFile(
    join(dir, 'runtime/themes/editorial-forest.css'),
    '/* 主题：Editorial Forest（配色取自 …）\n' +
      ' * 标签：editorial\n' +
      ' * 一句话：沉静，有读物的分量\n' +
      ' * 在 tokens.css 之后引入。\n */',
  )
  await writeFile(join(dir, 'runtime/themes/clearing.css'), '/* 没写主题名，也没挂标签 */')
  await writeFile(
    join(dir, 'runtime/tags.json'),
    JSON.stringify({ tags: [{ id: 'editorial', label: '社论' }] }),
  )
  await writeFile(join(dir, 'runtime/themes/notes.md'), 'ignore me')
  await writeFile(join(dir, 'templates/layouts/bento.html'), '<div></div>')
  return dir
}

describe('resolveSkillPath', () => {
  it('认 SKILL.md —— 目录长得像不算数', async () => {
    const dir = await fakeSkill()
    expect(await resolveSkillPath({ ORCA_PPT_SKILL: dir })).toBe(dir)
  })

  it('app 自带的那一份排在本地仓前面 —— 发布版的 skill 要和 app 版本对得上', async () => {
    const bundled = await fakeSkill()
    expect(await resolveSkillPath({ ORCA_PPT_BUNDLED_SKILL: bundled })).toBe(bundled)
  })

  it('显式指定的还能盖过自带的 —— 开发时要拿它试 skill 的改动', async () => {
    const bundled = await fakeSkill()
    const explicit = await fakeSkill()
    expect(
      await resolveSkillPath({ ORCA_PPT_SKILL: explicit, ORCA_PPT_BUNDLED_SKILL: bundled }),
    ).toBe(explicit)
  })

  it('指过去的路径不是 skill 就往下找,而不是硬用', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'notskill-'))
    const resolved = await resolveSkillPath({ ORCA_PPT_SKILL: empty })
    expect(resolved).not.toBe(empty)
  })
})

describe('readCatalog', () => {
  it('列出主题和版式,主题用注释里那个人读的名字', async () => {
    const catalog = await readCatalog(await fakeSkill())
    expect(catalog.themes).toEqual([
      // 没写标签的主题给空数组,不编一个
      { name: 'clearing', title: 'clearing', tags: [] },
      {
        name: 'editorial-forest',
        title: 'Editorial Forest',
        summary: '沉静，有读物的分量',
        tags: ['editorial'],
      },
    ])
    expect(catalog.layouts).toEqual(['bento'])
  })

  it('非 css 文件不算主题', async () => {
    const catalog = await readCatalog(await fakeSkill())
    expect(catalog.themes.map((t) => t.name)).not.toContain('notes')
  })

  it('没有 skill 时给空目录,不抛', async () => {
    expect(await readCatalog(undefined)).toEqual({ themes: [], layouts: [], tagIssues: [] })
  })
})

describe('主题样张', () => {
  it('有样张就带上路径', async () => {
    const dir = await fakeSkill()
    await mkdir(join(dir, 'runtime/themes/samples'), { recursive: true })
    await writeFile(join(dir, 'runtime/themes/samples/clearing.jpg'), 'jpg')
    const catalog = await readCatalog(dir)
    expect(catalog.themes.find((t) => t.name === 'clearing')?.sample).toContain('clearing.jpg')
  })

  it('没样张就不带 —— 界面据此不显示它,一张白卡片人看不出在挑什么', async () => {
    const catalog = await readCatalog(await fakeSkill())
    expect(catalog.themes.every((t) => t.sample === undefined)).toBe(true)
  })
})

describe('标签', () => {
  it('只认词表里的 id,不在词表里的丢掉', async () => {
    const dir = await fakeSkill()
    await writeFile(
      join(dir, 'runtime/themes/rogue.css'),
      ['/* 主题：Rogue', ' * 标签：editorial / 我自己造的词', ' */'].join('\n'),
    )
    const catalog = await readCatalog(dir)
    expect(catalog.themes.find((t) => t.name === 'rogue')?.tags).toEqual(['editorial'])
  })

  it('拼错的要报出来 —— 默默接受错别字等于回到自由发挥', async () => {
    const dir = await fakeSkill()
    await writeFile(
      join(dir, 'runtime/themes/rogue.css'),
      ['/* 主题：Rogue', ' * 标签：editoral', ' */'].join('\n'),
    )
    const catalog = await readCatalog(dir)
    expect(catalog.tagIssues.join()).toContain('editoral')
  })

  it('一个标签都没挂的也要报 —— 上新一份模板必须挑一个', async () => {
    const catalog = await readCatalog(await fakeSkill())
    expect(catalog.tagIssues.join()).toContain('clearing')
  })

  it('读不到词表时原样放行 —— 校验是为了抓错别字,不是缺文件时清空标签', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skill-'))
    await writeFile(join(dir, 'SKILL.md'), '# skill')
    await mkdir(join(dir, 'runtime/themes'), { recursive: true })
    await writeFile(
      join(dir, 'runtime/themes/x.css'),
      ['/* 主题：X', ' * 标签：whatever', ' */'].join('\n'),
    )
    const catalog = await readCatalog(dir)
    expect(catalog.themes[0]?.tags).toEqual(['whatever'])
  })
})

describe('主题的默认配色', () => {
  it('读出来 —— 主题里没有颜色,建稿子时要按它把配色一起链上', async () => {
    const dir = await fakeSkill()
    await writeFile(
      join(dir, 'runtime/themes/x.css'),
      ['/* 主题：X', ' * 默认配色：forest', ' */'].join('\n'),
    )
    const catalog = await readCatalog(dir)
    expect(catalog.themes.find((t) => t.name === 'x')?.palette).toBe('forest')
  })

  it('没写就没有 —— 不猜一个', async () => {
    const catalog = await readCatalog(await fakeSkill())
    expect(catalog.themes.every((t) => t.palette === undefined)).toBe(true)
  })
})
