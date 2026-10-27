import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DEFAULT_DECKS_DIR } from './create.js'
import { countTopLevelSections, findEntryName } from './decks.js'

/**
 * 首页「我的」:用户自己的稿子。
 *
 * 两个来源合起来:默认目录(`~/Documents/Orca PPT`)下的每一份,加上在别处新建、打开过的
 * (记在 `~/.orca-ppt/recent-decks.json`)。只扫默认目录会漏 —— 稿子可以建在任何地方,
 * 用户也随时会把目录挪走;只看记录又会漏掉助手用自己的文件工具在默认目录里做的稿子。
 *
 * 记录坏了就当没有:少列几份,不值得让打开稿子这件事失败。
 */

/** 记录最多留这么多份。默认目录下的不受这个限制。 */
const LIMIT = 50

export function recentDecksFilePath(env = process.env): string {
  return env.ORCA_PPT_RECENT_DECKS_FILE ?? join(homedir(), '.orca-ppt', 'recent-decks.json')
}

interface Used {
  path: string
  usedAt: number
}

async function readUsed(env: NodeJS.ProcessEnv): Promise<Used[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recentDecksFilePath(env), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is Used => typeof item?.path === 'string' && typeof item?.usedAt === 'number',
    )
  } catch {
    return []
  }
}

/** 记一次新建或打开。已经在里面的提到最前,不重复。 */
export async function noteDeckUsed(
  path: string,
  env = process.env,
  now = Date.now(),
): Promise<void> {
  try {
    const at = await realpath(path).catch(() => path)
    const next = [
      { path: at, usedAt: now },
      ...(await readUsed(env)).filter((item) => item.path !== at),
    ].slice(0, LIMIT)
    const file = recentDecksFilePath(env)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(next), 'utf8')
  } catch {
    // 写不了就算了 —— 首页少列一份。
  }
}

export interface MyDeck {
  path: string
  title: string
  /** 稿子文件最后一次改动的时间;还没出成品时是目录的时间。 */
  updatedAt: number
  slideCount: number
}

/**
 * 用户的稿子,最近动过的在前:最近一次改动和最近一次打开,取晚的那个。
 * 目录不在了、不是稿子目录(没有 deck.html / index.html,也没有 .deck/)的不列。
 */
export async function listMyDecks(
  env = process.env,
  decksDir = DEFAULT_DECKS_DIR,
): Promise<MyDeck[]> {
  const used = await readUsed(env)
  const children = await readdir(decksDir, { withFileTypes: true }).catch(() => [])
  const candidates = [
    ...used,
    ...children
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ path: join(decksDir, entry.name), usedAt: 0 })),
  ]

  const found = new Map<string, MyDeck & { recentAt: number }>()
  for (const candidate of candidates) {
    const deck = await readMyDeck(candidate.path)
    if (!deck) continue
    const recentAt = Math.max(deck.updatedAt, candidate.usedAt)
    const seen = found.get(deck.path)
    if (!seen || seen.recentAt < recentAt) found.set(deck.path, { ...deck, recentAt })
  }
  return [...found.values()]
    .sort((a, b) => b.recentAt - a.recentAt)
    .map(({ recentAt: _, ...deck }) => deck)
}

async function readMyDeck(path: string): Promise<MyDeck | undefined> {
  try {
    const root = await realpath(path)
    const name = await findEntryName(root)
    if (!name) {
      // 刚建、成品还没出来的稿子也算:目录里有 .deck/ 就是
      const info = await stat(join(root, '.deck'))
      if (!info.isDirectory()) return undefined
      return { path: root, title: basename(root), updatedAt: info.mtimeMs, slideCount: 0 }
    }
    const file = join(root, name)
    const [info, html] = await Promise.all([stat(file), readFile(file, 'utf8')])
    return {
      path: root,
      title: basename(root),
      updatedAt: info.mtimeMs,
      slideCount: countTopLevelSections(html),
    }
  } catch {
    return undefined
  }
}
