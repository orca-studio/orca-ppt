import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import type { RequestResult } from '@orca-ppt/contracts'
import { recipePrompt } from '@orca-ppt/deck-agent'

type Recipe = RequestResult<'catalog.recipes'>['recipes'][number]

/**
 * 读 skill 里的同款:`recipes/<id>/RECIPE.md` 开头的 frontmatter。
 *
 * 只读 frontmatter 那几个键 —— 配方正文是给 agent 读的,界面不解析、不展示。
 * frontmatter 缺 id 或 title 的不进列表(不猜);id 和目录名不一致的也不进,
 * 提示词里写的路径是按 id 拼的,对不上 agent 就读不到。
 */
export async function listRecipes(skillPath: string | undefined): Promise<Recipe[]> {
  if (!skillPath) return []
  const root = join(skillPath, 'recipes')
  let dirs: string[]
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'),
      )
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }

  const recipes: Array<Recipe & { order: number }> = []
  for (const dir of dirs) {
    const text = await readFile(join(root, dir, 'RECIPE.md'), 'utf8').catch(() => '')
    const meta = frontmatter(text)
    if (!meta.id || !meta.title || meta.id !== dir) continue
    const order = Number(meta.order)
    recipes.push({
      order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
      id: meta.id,
      title: meta.title,
      mode: meta.mode ?? '汇报稿',
      ...(meta.summary ? { summary: meta.summary } : {}),
      prompt: recipePrompt({
        id: meta.id,
        title: meta.title,
        summary: meta.summary,
        sample: meta.sample ? skillRelative(dir, meta.sample) : undefined,
      }),
    })
  }
  // 首页的顺序:frontmatter 的 order 小的在前(首推的同款写 1),没写的排后面,再按目录名
  return recipes
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(({ order: _order, ...recipe }) => recipe)
}

/** `sample`(相对配方目录)换成相对 skill 根的路径,提示词里给 agent 用;出了 skill 就不给。 */
function skillRelative(dir: string, sample: string): string | undefined {
  const path = posix.normalize(posix.join('recipes', dir, sample)).replace(/\/$/, '')
  return path.startsWith('..') || posix.isAbsolute(path) ? undefined : path
}

/**
 * 同款样稿的入口文件。只认 listRecipes 认得的 id,不拿 id 拼路径去碰别的目录。
 *
 * 样稿可以直接放在配方目录里(`recipes/<id>/index.html`),也可以用 frontmatter 的
 * `sample` 指向 skill 里现成的示例(比如 `sample: ../../examples/drink-showcase`)——
 * 示例还被展示站、测试和规范文档用着,不复制第二份。`sample` 必须落在 skill 目录以内。
 */
export async function recipeEntry(
  skillPath: string | undefined,
  id: string,
): Promise<RecipeSource | undefined> {
  const known = (await listRecipes(skillPath)).find((item) => item.id === id)
  if (!skillPath || !known) return undefined
  const home = join(skillPath, 'recipes', id)
  const meta = frontmatter(await readFile(join(home, 'RECIPE.md'), 'utf8'))
  const dir = meta.sample ? await withinSkill(skillPath, resolve(home, meta.sample)) : home
  if (!dir) return undefined
  const entry = await existing(join(dir, 'index.html'))
  if (!entry) return undefined
  // 封面取样片第几秒(cover)。写错了不猜,交给录制器取默认
  const cover = Number(meta.cover)
  return {
    dir,
    entry,
    title: known.title,
    coverAt: Number.isFinite(cover) ? cover : undefined,
    range: pageRange(meta.preview),
  }
}

export interface RecipeSource {
  dir: string
  entry: string
  title: string
  /** 封面取样片第几秒。 */
  coverAt: number | undefined
  /** 样片只录这几页(下标,含两头)。 */
  range: { from: number; to: number } | undefined
}

/** 样片录哪几页:`preview: 4-5`(页号从 1 数,含两头)→ 下标。写错了就录整份。 */
export function pageRange(value: string | undefined): { from: number; to: number } | undefined {
  const match = value?.match(/^(\d+)\s*-\s*(\d+)$/)
  if (!match) return undefined
  const from = Number(match[1]) - 1
  const to = Number(match[2]) - 1
  return from >= 0 && to >= from ? { from, to } : undefined
}

/** 真实路径落在 skill 目录以内才返回(先 realpath 再比,软链绕不出去)。 */
async function withinSkill(skillPath: string, path: string): Promise<string | undefined> {
  const [root, target] = await Promise.all([
    realpath(skillPath).catch(() => undefined),
    realpath(path).catch(() => undefined),
  ])
  if (!root || !target) return undefined
  const rel = relative(root, target)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? target : undefined
}

/** 只认最简单的 `键: 值` 一行一个,不引 YAML 库。值里的冒号保留。 */
export function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match?.[1]) return {}
  const out: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (kv?.[1] && kv[2]?.trim()) out[kv[1]] = kv[2].trim()
  }
  return out
}

async function existing(path: string): Promise<string | undefined> {
  return stat(path).then(
    (info) => (info.isFile() ? path : undefined),
    () => undefined,
  )
}
