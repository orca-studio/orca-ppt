import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listMyDecks, noteDeckUsed } from './recent-decks.js'

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'my-decks-')))
  const env = { ORCA_PPT_RECENT_DECKS_FILE: join(root, 'recent-decks.json') }
  const decksDir = join(root, 'Orca PPT')
  await mkdir(decksDir)
  return { root, env, decksDir }
}

/** 一份稿子,deck.html 的修改时间设成 `at`(秒)。 */
async function deck(dir: string, at: number, slides = 2) {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'deck.html')
  await writeFile(file, '<div class="slides">' + '<section></section>'.repeat(slides) + '</div>')
  await utimes(file, at, at)
  return dir
}

describe('listMyDecks', () => {
  it('默认目录下的都列,最近改过的在前', async () => {
    const { env, decksDir } = await setup()
    await deck(join(decksDir, '旧的'), 1_000)
    await deck(join(decksDir, '新的'), 2_000, 6)
    const decks = await listMyDecks(env, decksDir)
    expect(decks.map((d) => d.title)).toEqual(['新的', '旧的'])
    expect(decks[0]).toMatchObject({ slideCount: 6, updatedAt: 2_000_000 })
  })

  it('别处新建、打开过的也列;最近打开的排到前面', async () => {
    const { root, env, decksDir } = await setup()
    await deck(join(decksDir, '默认目录里的'), 2_000)
    const elsewhere = await deck(join(root, 'project', '别处的'), 1_000)
    await noteDeckUsed(elsewhere, env, 3_000_000)
    const decks = await listMyDecks(env, decksDir)
    expect(decks.map((d) => d.title)).toEqual(['别处的', '默认目录里的'])
  })

  it('同一份只列一次:默认目录下的又打开过', async () => {
    const { env, decksDir } = await setup()
    const dir = await deck(join(decksDir, '一份'), 1_000)
    await noteDeckUsed(dir, env)
    expect(await listMyDecks(env, decksDir)).toHaveLength(1)
  })

  it('删掉了、不是稿子的目录不列;刚建还没成品的列', async () => {
    const { root, env, decksDir } = await setup()
    const gone = await deck(join(root, '删掉的'), 1_000)
    await noteDeckUsed(gone, env)
    await rm(gone, { recursive: true })
    await mkdir(join(decksDir, '随便一个文件夹'))
    await mkdir(join(decksDir, '刚建的', '.deck'), { recursive: true })
    const decks = await listMyDecks(env, decksDir)
    expect(decks.map((d) => [d.title, d.slideCount])).toEqual([['刚建的', 0]])
  })

  it('记录坏了、默认目录不在都当没有', async () => {
    const { root, env } = await setup()
    await writeFile(env.ORCA_PPT_RECENT_DECKS_FILE, '不是 JSON')
    expect(await listMyDecks(env, join(root, '不在'))).toEqual([])
  })
})
