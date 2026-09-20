import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readRecentThemes } from './recent.js'
import { keepKnown, parseVocabulary, tagIssues, tagLine, type Vocabulary } from './tags.js'

/**
 * 规范、主题、版式、录制脚本都从 skill 目录读,不抄进本仓 —— skill 更新产品跟着更新,
 * 不两边同步(见 docs/DECK-MODE.md 末节)。
 */
/**
 * 两个名字都认:仓从 `orca-transition-skill` 改成了 `orca-ppt-skill`(和应用同源),
 * 但已经克隆在本地的旧目录不会自己改名,也不该因此突然找不到 skill。
 */
const DEFAULT_LOCATIONS = [
  join(homedir(), 'ghq/github.com/zhenwusw/orca-ppt-skill'),
  join(homedir(), '.claude/skills/orca-ppt'),
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
  themes: Theme[]
  layouts: string[]
  /**
   * 标签有毛病的条目,一条一句人话:拼错的、以及**一个标签都没挂的**。
   * 词表是靠这份报告执行的,不是靠文档 —— 不默默放过。
   */
  tagIssues: string[]
  skillPath?: string
}

/**
 * 一个主题。
 *
 * **主题就是场景** —— 用这个产品的人都带着自己的场合来:年度复盘、对外路演、内部分享。
 */
export interface Theme {
  name: string
  title: string
  /** 一句话:适合什么场合、什么调子。**不是标签** —— 不参与分区,也不参与筛选。 */
  summary?: string
  /**
   * 标签。**从 skill 的 `runtime/tags.json` 里挑,不能自由决定。**
   *
   * 那份词表直接取自 Keynote 的主题侧边栏。自己边写边造的词(「刊物感」「读物感」)
   * 只是对某一个主题的描述,不是一份被决定过的词表 —— 它们各自只会有一个条目挂上去,
   * 永远成不了区。
   *
   * **上新一个主题必须挑一个标签。** 拼错的、没挂标签的都会记进 catalog 的
   * `tagIssues` —— 词表靠报告执行,不靠文档。
   */
  tags: string[]
  /**
   * 样张的绝对路径 —— **每个主题一张,内容完全一样**,只有设计不同(见 skill 的
   * scripts/theme-samples.mjs)。没有样张的主题不进选择器:一张白卡片,人看不出
   * 自己在挑什么。
   */
  sample?: string
  /**
   * 这个主题默认配哪套配色。
   *
   * **主题文件里已经没有颜色了** —— 颜色在 `runtime/palettes/` 里,主题只管字体、
   * 字阶、圆角、新增类。所以新建稿子时必须按这个把配色一起链上,不然建出来是没颜色的。
   */
  palette?: string
}

/** 主题和版式是**选**出来的,不是聊出来的。 */
export async function readCatalog(skillPath: string | undefined): Promise<Catalog> {
  if (!skillPath) return { themes: [], layouts: [], tagIssues: [] }

  const vocabulary = await readVocabulary(skillPath)
  const dir = join(skillPath, 'runtime/themes')
  const names = await readNames(dir, '.css')
  const read = await Promise.all(names.map((name) => readTheme(dir, name, vocabulary)))

  return {
    themes: read.map((entry) => entry.theme),
    layouts: await readNames(join(skillPath, 'templates/layouts'), '.html'),
    tagIssues: tagIssues(
      read.map((entry) => ({
        name: entry.theme.name,
        tags: entry.theme.tags,
        unknown: entry.unknown,
      })),
      vocabulary,
    ),
    skillPath,
  }
}

/** 页面类型词表(`runtime/pages.json`)。读不到就当空。 */
export async function readPageTypes(
  skillPath: string,
): Promise<Array<{ id: string; label: string }>> {
  try {
    const json: unknown = JSON.parse(await readFile(join(skillPath, 'runtime/pages.json'), 'utf8'))
    const pages = (json as Record<string, unknown>)?.pages
    if (!Array.isArray(pages)) return []
    return pages.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const { id, label } = entry as Record<string, unknown>
      if (typeof id !== 'string' || !id) return []
      return [{ id, label: typeof label === 'string' && label ? label : id }]
    })
  } catch {
    return []
  }
}

/** 词表。读不到就当空 —— 校验是为了发现错别字,不是为了在缺文件时把标签清空。 */
export async function readVocabulary(skillPath: string): Promise<Vocabulary> {
  try {
    return parseVocabulary(JSON.parse(await readFile(join(skillPath, 'runtime/tags.json'), 'utf8')))
  } catch {
    return []
  }
}

async function readTheme(
  dir: string,
  name: string,
  vocabulary: Vocabulary,
): Promise<{ theme: Theme; unknown: string[] }> {
  const head = await readFile(join(dir, `${name}.css`), 'utf8').then(
    (text) => text.slice(0, 600),
    () => '',
  )
  const sample = join(dir, 'samples', `${name}.jpg`)
  const hasSample = await stat(sample).then(
    () => true,
    () => false,
  )
  const { kept, unknown } = keepKnown(tagLine(head, '标签'), vocabulary)
  const summary = head.match(/一句话[:：]\s*([^\n]+)/)?.[1]?.trim()
  const palette = head.match(/默认配色[:：]\s*([a-z0-9-]+)/)?.[1]

  return {
    theme: {
      name,
      // 主题文件开头那行注释里写着人读的名字,比文件名好看。
      title: head.match(/主题[:：]\s*([^\n(（]+)/)?.[1]?.trim() || name,
      ...(summary ? { summary } : {}),
      tags: kept,
      ...(hasSample ? { sample } : {}),
      ...(palette ? { palette } : {}),
    },
    unknown,
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
