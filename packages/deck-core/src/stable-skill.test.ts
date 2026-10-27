import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linkStableSkill, stableSkillPath } from './stable-skill.js'
import { instantiate } from './templates.js'

/** 一份假 skill:SKILL.md、起始文件、一个运行时文件,内容带上是哪一份。 */
async function fakeSkill(name: string) {
  const root = await mkdtemp(join(tmpdir(), `skill-${name}-`))
  await mkdir(join(root, 'templates'), { recursive: true })
  await mkdir(join(root, 'runtime'), { recursive: true })
  await writeFile(join(root, 'SKILL.md'), `# ${name}`)
  await writeFile(join(root, 'runtime/tokens.css'), `/* ${name} */`)
  await writeFile(
    join(root, 'templates/starter.html'),
    '<head><link href="{{ROOT}}/runtime/tokens.css"></head>',
  )
  return root
}

const env = async () => ({
  ORCA_PPT_STABLE_SKILL: join(await mkdtemp(join(tmpdir(), 'stable-')), 'orca-ppt', 'skill'),
})

describe('stableSkillPath', () => {
  it('macOS / Linux 在 ~/.local/share 下,Windows 在 LOCALAPPDATA 下', () => {
    expect(stableSkillPath({ HOME: '/h' }, 'darwin')).toMatch(/\.local\/share\/orca-ppt\/skill$/)
    expect(stableSkillPath({ XDG_DATA_HOME: '/x' }, 'linux')).toBe('/x/orca-ppt/skill')
    expect(stableSkillPath({ LOCALAPPDATA: 'C:\\L' }, 'win32')).toBe(
      join('C:\\L', 'OrcaPPT', 'skill'),
    )
  })
})

describe('linkStableSkill', () => {
  it('建一个链接指向这份 skill;再调一次什么都不变', async () => {
    const skill = await fakeSkill('a')
    const e = await env()
    const stable = await linkStableSkill(skill, e)
    expect(stable).toBe(e.ORCA_PPT_STABLE_SKILL)
    expect((await lstat(stable!)).isSymbolicLink()).toBe(true)
    expect(await realpath(stable!)).toBe(await realpath(skill))
    expect(await linkStableSkill(skill, e)).toBe(stable)
  })

  it('换了一份 skill(升级、换 Node 版本)就改指过去', async () => {
    const e = await env()
    await linkStableSkill(await fakeSkill('old'), e)
    const next = await fakeSkill('new')
    await linkStableSkill(next, e)
    expect(resolve(dirname(e.ORCA_PPT_STABLE_SKILL), await readlink(e.ORCA_PPT_STABLE_SKILL))).toBe(
      await realpath(next),
    )
  })

  it('那里是个真目录就不碰,返回 undefined', async () => {
    const e = await env()
    await mkdir(e.ORCA_PPT_STABLE_SKILL, { recursive: true })
    await writeFile(join(e.ORCA_PPT_STABLE_SKILL, 'mine.txt'), '用户自己的')
    expect(await linkStableSkill(await fakeSkill('a'), e)).toBeUndefined()
    expect(await readFile(join(e.ORCA_PPT_STABLE_SKILL, 'mine.txt'), 'utf8')).toBe('用户自己的')
  })
})

describe('稿子经固定位置引 skill', () => {
  it('skill 换了位置,老稿子引到的是新的那份 —— 不丢样式', async () => {
    const e = await env()
    const first = await fakeSkill('first')
    const link = await linkStableSkill(first, e)
    const deck = join(await mkdtemp(join(tmpdir(), 'deck-')), 'new')
    await instantiate({
      skillPath: first,
      templateId: 'template:starter.html',
      targetDir: deck,
      skillLink: link,
    })
    const href = /href="([^"]+tokens\.css)"/.exec(
      await readFile(join(deck, 'deck.html'), 'utf8'),
    )![1]!
    // 引的是链接,不是这份 skill 真正的位置
    expect(href).toContain('orca-ppt/skill/runtime/tokens.css')

    await linkStableSkill(await fakeSkill('second'), e)
    expect(await readFile(join(await realpath(deck), href), 'utf8')).toBe('/* second */')
  })
})
