import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 规范、主题、版式、录制脚本都从 skill 目录读,不抄进本仓 —— skill 更新产品跟着更新,
 * 不两边同步(见 docs/DECK-MODE.md 末节)。
 */
const DEFAULT_LOCATIONS = [
  join(homedir(), 'ghq/github.com/zhenwusw/orca-transition-skill'),
  join(homedir(), '.claude/skills/orca-transition'),
]

export async function resolveSkillPath(env = process.env): Promise<string | undefined> {
  const candidates = env.ORCA_PPT_SKILL
    ? [env.ORCA_PPT_SKILL, ...DEFAULT_LOCATIONS]
    : DEFAULT_LOCATIONS

  for (const candidate of candidates) {
    try {
      // SKILL.md 在就认,别的目录长得再像也不是。
      await readFile(join(candidate, 'SKILL.md'), 'utf8')
      return candidate
    } catch {
      // 下一个
    }
  }
  return undefined
}

export interface Catalog {
  themes: Array<{ name: string; title: string }>
  layouts: string[]
  skillPath?: string
}

/** 主题和版式是**选**出来的,不是聊出来的。 */
export async function readCatalog(skillPath: string | undefined): Promise<Catalog> {
  if (!skillPath) return { themes: [], layouts: [] }

  const themes = await readThemes(join(skillPath, 'runtime/themes'))
  const layouts = await readNames(join(skillPath, 'templates/layouts'), '.html')
  return { themes, layouts, skillPath }
}

async function readThemes(dir: string): Promise<Array<{ name: string; title: string }>> {
  const names = await readNames(dir, '.css')
  return Promise.all(
    names.map(async (name) => ({ name, title: await themeTitle(join(dir, `${name}.css`), name) })),
  )
}

/** 主题文件开头那行注释里写着人读的名字,比文件名好看。 */
async function themeTitle(file: string, fallback: string): Promise<string> {
  try {
    const head = (await readFile(file, 'utf8')).slice(0, 400)
    const match = head.match(/主题[:：]\s*([^\n(（]+)/)
    return match?.[1]?.trim() || fallback
  } catch {
    return fallback
  }
}

async function readNames(dir: string, extension: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries
      .filter((entry) => entry.endsWith(extension))
      .map((entry) => entry.slice(0, -extension.length))
      .sort()
  } catch {
    return []
  }
}
