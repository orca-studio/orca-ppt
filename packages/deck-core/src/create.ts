import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { recipeEntry } from './recipes.js'
import type { Theme } from './skill.js'
import { instantiate, instantiateSample } from './templates.js'

/**
 * agent 新建稿子没说放哪时的默认目录。不给默认值的话,agent 会从别的稿子路径里猜,
 * 猜出来的地方每次不一样。稿子是磁盘上的普通目录,放在文稿里用户找得到、拿得走。
 */
export const DEFAULT_DECKS_DIR = join(homedir(), 'Documents', 'Orca PPT')

/**
 * agent 常写 `~/Documents/…`。不展开的话它会被当成相对路径,拼到当前工作目录下
 * (`apps/desktop/~/Documents/…`),报一个让人摸不着头脑的 ENOENT。
 */
export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** 目录名。中文标题原样留着,只把路径里不能用的字符换掉。 */
function slugify(title: string): string {
  const cleaned = title.trim().replace(/[/\\:*?"<>|]/g, '-')
  return cleaned || `deck-${Date.now()}`
}

/**
 * 新建一份稿子,返回目录。server 的 `deck.create` 和 CLI 的 `new` 都走这里。
 *
 * - `from: 'recipe:<id>'`:做同款,从同款的样稿起头,主题和配色沿用样稿的(`theme` 不生效);
 * - `from: 'template:<文件>'`:从空白起始文件起头,配上主题和它默认的配色;
 * - 不给 `from`:只建一个空目录(带 `.deck/`)。
 */
export async function createDeck(options: {
  skillPath: string | undefined
  /** skill 里的主题,用来查主题默认配哪套配色(见 readCatalog)。 */
  themes: Theme[]
  title: string
  parentDir?: string | undefined
  from?: string | undefined
  theme?: string | undefined
}): Promise<{ path: string }> {
  const { skillPath, themes, title, from, theme } = options
  const path = join(expandHome(options.parentDir ?? DEFAULT_DECKS_DIR), slugify(title))

  if (from?.startsWith('recipe:')) {
    const sample = await recipeEntry(skillPath, from.slice('recipe:'.length))
    if (!sample) throw new Error(`不认识的同款:${from}(id 来自 list_recipes)`)
    if (sample.kind === 'example')
      throw new Error(`${from} 是案例,不是同款:案例只能打开看,不能做同款`)
    await instantiateSample({ sampleDir: sample.dir, entry: sample.entry, targetDir: path, title })
  } else if (from) {
    if (!skillPath) throw new Error('找不到 skill,没有起始文件可用')
    // 主题文件里没有颜色,配色得一起链上 —— 不然建出来的稿子是没颜色的。
    const palette = theme ? themes.find((item) => item.name === theme)?.palette : undefined
    await instantiate({
      skillPath,
      templateId: from,
      targetDir: path,
      title,
      ...(theme ? { theme } : {}),
      ...(palette ? { palette } : {}),
    })
  } else {
    await mkdir(join(path, '.deck'), { recursive: true })
  }
  return { path }
}
