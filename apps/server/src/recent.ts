import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 最近用过哪些主题 —— **一个派生标签**。
 *
 * 它不是内容的属性,是**使用**的属性:同一个主题今天带「最近使用」,下个月就不带了。
 * 分类表长不出这种东西,标签系统天然容得下(见 tags.ts)。而且它是选择器上最有用的
 * 一个标签:下次要挑哪个,最强的预测就是上次挑了哪个 —— 一个团队常年只用一两个主题。
 *
 * 存在 `~/.orca-ppt/recent.json`,和端口文件同一个目录。坏了就当没有:
 * 少一个标签而已,不值得让应用起不来。
 */

const LIMIT = 3

export function recentFilePath(env = process.env): string {
  return env.ORCA_PPT_RECENT_FILE ?? join(homedir(), '.orca-ppt', 'recent.json')
}

/** 最近用过的主题,最近的在前。 */
export async function readRecentThemes(env = process.env): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recentFilePath(env), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string').slice(0, LIMIT)
  } catch {
    // 没有、读不了、不是 JSON —— 都当没有。
    return []
  }
}

/** 记一次使用。已经在里面的提到最前,不重复。 */
export async function noteThemeUsed(theme: string, env = process.env): Promise<void> {
  if (!theme) return
  const next = [theme, ...(await readRecentThemes(env)).filter((item) => item !== theme)].slice(
    0,
    LIMIT,
  )
  try {
    const path = recentFilePath(env)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(next), 'utf8')
  } catch {
    // 写不了就算了 —— 少一个标签,不值得让打开稿子这件事失败。
  }
}

/**
 * 一份稿子用的是哪个主题。从它引的那行 `runtime/themes/<名字>.css` 认出来。
 *
 * 按文件名认,不按主题里写的名字:稿子引的就是文件,而 catalog 里主题的 key 也是文件名。
 */
export function themeOf(html: string): string | undefined {
  return html.match(/runtime\/themes\/([A-Za-z0-9_-]+)\.css/)?.[1]
}
