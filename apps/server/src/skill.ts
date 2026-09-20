import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readRecentThemes } from './recent.js'
import { tagLine, type TagSet } from './tags.js'

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
  skillPath?: string
}

/**
 * 一个主题。
 *
 * **主题就是场景** —— 用这个产品的人都带着自己的场合来:年度复盘、对外路演、内部分享。
 * 所以卡上要写它适合什么场合,不能只写它长什么样;光看颜色人挑不出来。
 */
export interface ThemeTags extends TagSet {
  /** 什么场合用它:年度复盘、对外路演、内部分享。**声明的** —— 写在主题文件头里。 */
  scene: string[]
  /** 什么调子:沉静、高对比、衬线。**声明的**。 */
  style: string[]
  /**
   * 怎么用过它。目前只有「最近使用」。**派生的** —— 从文件之外的状态算出来,
   * 同一个主题今天带、下个月就不带了。
   *
   * 分类表长不出这种东西:它不是内容的属性,是使用的属性。标签系统天然容得下,
   * 而且这是选择器上最有用的一个标签 —— 下次挑哪个,最强的预测是上次挑了哪个。
   */
  use: string[]
}

export interface Theme {
  name: string
  title: string
  /**
   * 这个主题带的标签,按轴分组。写在主题文件开头的「场景：」「风格：」两行。
   *
   * **是标签,不是描述**:同一个标签会横跨好几个主题(「高对比」在两个主题里,
   * 「衬线」在三个),主题多起来之后这就是筛选条的数据 —— 存成一句散文就永远过滤不了。
   *
   * 为什么是一个 `tags` 而不是并列的 `scenes` / `styles` 两个字段:那样读起来像
   * 这一个主题自己的两条属性,看不出它们是同一类东西,加第三个轴的人多半会写成一个
   * 标量,当场破掉这个模式。包成一层之后,轴是可枚举的 —— 将来的筛选条直接
   * `Object.entries(tags)` 就能铺开。
   *
   * 轴仍然是具名的(不是 `Record<string, string[]>`):界面对两个轴的处理**不一样** ——
   * 场景是人先问的那一半,给正文色;风格是补充,淡一档。开放的 record 会把这个丢掉。
   *
   * Keynote 的侧边栏正是这么长出来的:它的主题名就是「场景(风格)」——「烹饪(朴素)」
   * 「品牌(现代)」,一套命名同时生出两个轴,所以一个主题会出现在好几处。
   */
  tags: ThemeTags
  /**
   * 样张的绝对路径 —— **每个主题一张,内容完全一样**,只有设计不同(见 skill 的
   * scripts/theme-samples.mjs)。没有样张的主题不进选择器:一张白卡片,人看不出
   * 自己在挑什么。
   */
  sample?: string
}

/** 主题和版式是**选**出来的,不是聊出来的。 */
/**
 * 读出 catalog。**只读声明的标签** —— 派生的不在这儿算,见 `withDerivedTags`。
 *
 * 为什么分开:catalog 在启动时读一次就缓存了(它跟着文件走,文件不动它就不动),
 * 而派生标签跟着**状态**走,缓存它等于取消它 —— 「最近使用」永远停在应用启动那一刻。
 * 这个错犯过一次,别再犯。
 */
export async function readCatalog(skillPath: string | undefined): Promise<Catalog> {
  if (!skillPath) return { themes: [], layouts: [] }

  const themes = await readThemes(join(skillPath, 'runtime/themes'))
  const layouts = await readNames(join(skillPath, 'templates/layouts'), '.html')
  return { themes, layouts, skillPath }
}

async function readThemes(dir: string): Promise<Theme[]> {
  const names = await readNames(dir, '.css')
  return Promise.all(names.map((name) => readTheme(dir, name)))
}

/**
 * 把派生的标签盖上去。**每次请求现算** —— 它跟着状态走,不跟着文件走。
 *
 * 不改原对象:catalog 是缓存的,写进去就把「这一刻的状态」永久焊在缓存里了。
 */
export async function withDerivedTags(themes: Theme[], env = process.env): Promise<Theme[]> {
  const recent = await readRecentThemes(env)
  return themes.map((theme) => ({
    ...theme,
    tags: { ...theme.tags, use: recent.includes(theme.name) ? ['最近使用'] : [] },
  }))
}

async function readTheme(dir: string, name: string): Promise<Theme> {
  const head = await readFile(join(dir, `${name}.css`), 'utf8').then(
    (text) => text.slice(0, 600),
    () => '',
  )
  const sample = join(dir, 'samples', `${name}.jpg`)
  const hasSample = await stat(sample).then(
    () => true,
    () => false,
  )
  return {
    name,
    // 主题文件开头那行注释里写着人读的名字,比文件名好看。
    title: head.match(/主题[:：]\s*([^\n(（]+)/)?.[1]?.trim() || name,
    tags: {
      scene: tagLine(head, '场景'),
      style: tagLine(head, '风格'),
      // 派生的标签这儿一律给空,由 withDerivedTags 每次请求时盖上。
      use: [],
    },
    ...(hasSample ? { sample } : {}),
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
