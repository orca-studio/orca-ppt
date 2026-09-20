import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCatalog, resolveSkillPath, withDerivedTags } from './skill.js'

async function fakeSkill() {
  const dir = await mkdtemp(join(tmpdir(), 'skill-'))
  await writeFile(join(dir, 'SKILL.md'), '# skill')
  await mkdir(join(dir, 'runtime/themes'), { recursive: true })
  await mkdir(join(dir, 'templates/layouts'), { recursive: true })
  await writeFile(
    join(dir, 'runtime/themes/editorial-forest.css'),
    '/* 主题：Editorial Forest（配色取自 …）\n' +
      ' * 场景：年度复盘 / 研究汇报\n' +
      ' * 风格：沉静 · 衬线\n' +
      ' * 在 tokens.css 之后引入。\n */',
  )
  await writeFile(join(dir, 'runtime/themes/clearing.css'), '/* 没写主题名 */')
  await writeFile(join(dir, 'runtime/themes/notes.md'), 'ignore me')
  await writeFile(join(dir, 'templates/layouts/bento.html'), '<div></div>')
  return dir
}

describe('resolveSkillPath', () => {
  it('认 SKILL.md —— 目录长得像不算数', async () => {
    const dir = await fakeSkill()
    expect(await resolveSkillPath({ ORCA_PPT_SKILL: dir })).toBe(dir)
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
      // use 是派生的:没用过就是空,它不写在文件里
      { name: 'clearing', title: 'clearing', tags: { scene: [], style: [], use: [] } },
      {
        name: 'editorial-forest',
        title: 'Editorial Forest',
        tags: { scene: ['年度复盘', '研究汇报'], style: ['沉静', '衬线'], use: [] },
      },
    ])
    expect(catalog.layouts).toEqual(['bento'])
  })

  it('非 css 文件不算主题', async () => {
    const catalog = await readCatalog(await fakeSkill())
    expect(catalog.themes.map((t) => t.name)).not.toContain('notes')
  })

  it('没有 skill 时给空目录,不抛', async () => {
    expect(await readCatalog(undefined)).toEqual({ themes: [], layouts: [] })
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

describe('派生标签:最近使用', () => {
  it('用过的主题带上「最近使用」—— 它不写在文件里,是从使用记录算出来的', async () => {
    const recent = join(await mkdtemp(join(tmpdir(), 'orca-recent-')), 'recent.json')
    await writeFile(recent, JSON.stringify(['clearing']), 'utf8')

    const catalog = await readCatalog(await fakeSkill())
    const themes = await withDerivedTags(catalog.themes, { ORCA_PPT_RECENT_FILE: recent })
    expect(themes.find((t) => t.name === 'clearing')?.tags.use).toEqual(['最近使用'])
    expect(themes.find((t) => t.name === 'editorial-forest')?.tags.use).toEqual([])
  })

  it('没有使用记录时一个都不带,不编一个', async () => {
    const catalog = await readCatalog(await fakeSkill())
    const themes = await withDerivedTags(catalog.themes, { ORCA_PPT_RECENT_FILE: '/nope.json' })
    expect(themes.every((t) => t.tags.use.length === 0)).toBe(true)
  })

  it('**不在 readCatalog 里算** —— catalog 是缓存的,派生标签缓存了就等于取消了', async () => {
    const recent = join(await mkdtemp(join(tmpdir(), 'orca-recent-')), 'recent.json')
    await writeFile(recent, JSON.stringify(['clearing']), 'utf8')
    const catalog = await readCatalog(await fakeSkill())
    expect(catalog.themes.every((t) => t.tags.use.length === 0)).toBe(true)
  })

  it('不改原对象 —— 写进去就把这一刻的状态焊在缓存里了', async () => {
    const recent = join(await mkdtemp(join(tmpdir(), 'orca-recent-')), 'recent.json')
    await writeFile(recent, JSON.stringify(['clearing']), 'utf8')
    const catalog = await readCatalog(await fakeSkill())
    await withDerivedTags(catalog.themes, { ORCA_PPT_RECENT_FILE: recent })
    expect(catalog.themes.every((t) => t.tags.use.length === 0)).toBe(true)
  })
})
