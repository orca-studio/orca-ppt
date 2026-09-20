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
    '/* 主题：Editorial Forest（配色取自 …）\n * 在 tokens.css 之后引入。\n */',
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
      { name: 'clearing', title: 'clearing' },
      { name: 'editorial-forest', title: 'Editorial Forest' },
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
