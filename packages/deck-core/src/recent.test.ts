import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { noteThemeUsed, readRecentThemes, themeOf } from './recent.js'

let env: NodeJS.ProcessEnv

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-recent-'))
  env = { ORCA_PPT_RECENT_FILE: join(dir, 'recent.json') }
})

describe('最近用过的主题', () => {
  it('记一次,读得回来', async () => {
    await noteThemeUsed('editorial-forest', env)
    expect(await readRecentThemes(env)).toEqual(['editorial-forest'])
  })

  it('最近的在前', async () => {
    await noteThemeUsed('a', env)
    await noteThemeUsed('b', env)
    expect(await readRecentThemes(env)).toEqual(['b', 'a'])
  })

  it('再用一次是提到最前,不是多出一条', async () => {
    await noteThemeUsed('a', env)
    await noteThemeUsed('b', env)
    await noteThemeUsed('a', env)
    expect(await readRecentThemes(env)).toEqual(['a', 'b'])
  })

  it('只留最近几个 —— 全记下来就等于没记', async () => {
    for (const name of ['a', 'b', 'c', 'd']) await noteThemeUsed(name, env)
    expect(await readRecentThemes(env)).toEqual(['d', 'c', 'b'])
  })

  it('文件坏了就当没有 —— 少一个标签,不值得让应用起不来', async () => {
    await writeFile(env.ORCA_PPT_RECENT_FILE!, 'not json', 'utf8')
    expect(await readRecentThemes(env)).toEqual([])
  })

  it('文件里是别的东西也不炸', async () => {
    await writeFile(env.ORCA_PPT_RECENT_FILE!, '{"a":1}', 'utf8')
    expect(await readRecentThemes(env)).toEqual([])
    await writeFile(env.ORCA_PPT_RECENT_FILE!, '[1, null, "ok"]', 'utf8')
    expect(await readRecentThemes(env)).toEqual(['ok'])
  })

  it('没记过就是空,不编一个', async () => {
    expect(await readRecentThemes(env)).toEqual([])
  })

  it('空主题名不记 —— 不给「最近使用」挂一个空标签', async () => {
    await noteThemeUsed('', env)
    await expect(readFile(env.ORCA_PPT_RECENT_FILE!, 'utf8')).rejects.toThrow()
  })
})

describe('themeOf', () => {
  it('从稿子引的那行认出主题', () => {
    expect(themeOf('<link href="../../runtime/themes/editorial-forest.css">')).toBe(
      'editorial-forest',
    )
  })

  it('绝对路径也认', () => {
    expect(themeOf('<link href="/Users/x/skill/runtime/themes/clearing.css">')).toBe('clearing')
  })

  it('没引主题就是没有 —— 空白起始文件就是这样', () => {
    expect(themeOf('<link href="../../runtime/tokens.css">')).toBeUndefined()
  })
})
