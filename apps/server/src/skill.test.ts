import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCatalog, resolveSkillPath, tags } from './skill.js'

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
      { name: 'clearing', title: 'clearing', scenes: [], styles: [] },
      {
        name: 'editorial-forest',
        title: 'Editorial Forest',
        scenes: ['年度复盘', '研究汇报'],
        styles: ['沉静', '衬线'],
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

describe('tags', () => {
  const head = `/* 主题：Editorial Forest（取自别处）
 * 场景：年度复盘 / 研究汇报
 * 风格：沉静 · 衬线 · 读物感
 * 在 tokens.css 之后引入。*/`

  it('一行拆成一组标签', () => {
    expect(tags(head, '场景')).toEqual(['年度复盘', '研究汇报'])
    expect(tags(head, '风格')).toEqual(['沉静', '衬线', '读物感'])
  })

  it('几种分隔符都认 —— 这行是人手写的,为一个顿号漏掉半行不值得', () => {
    expect(tags(' * 场景：路演、年鉴,复盘 / 分享', '场景')).toEqual([
      '路演',
      '年鉴',
      '复盘',
      '分享',
    ])
  })

  it('没有这一行就是空,不报错也不编一个', () => {
    expect(tags('/* 主题：无标签 */', '场景')).toEqual([])
  })

  it('全角冒号和半角冒号都认', () => {
    expect(tags(' * 风格: 明快', '风格')).toEqual(['明快'])
  })

  it('注释的星号不会混进标签里', () => {
    expect(tags(' * 场景：产品发布 / 方案提案\n * 风格：明快', '场景')).toEqual([
      '产品发布',
      '方案提案',
    ])
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
