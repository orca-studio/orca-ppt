import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import type { RequestResult } from '@orca-ppt/contracts'
import { recipePrompt } from '@orca-ppt/deck-agent'

type Recipe = RequestResult<'catalog.recipes'>['recipes'][number]

/**
 * 读 skill 里首页要展示的东西:同款(`recipes/<id>/RECIPE.md`)和案例(`examples/<id>/EXAMPLE.md`)
 * 开头的 frontmatter。
 *
 * 只读 frontmatter 那几个键 —— 配方正文是给 agent 读的,界面不解析、不展示。
 * frontmatter 缺 id 或 title 的不进列表(不猜);id 和目录名不一致的也不进,
 * 提示词里写的路径是按 id 拼的,对不上 agent 就读不到。
 *
 * 案例是一整份完整的稿子(一种风格从头到尾怎么贯穿),不是可以换内容复刻的手法:
 * 没有「做同款」的提示词,首页只放封面。已经被某个同款的 `sample` 指着的示例不再单列,
 * 和同款撞了 id 的也不列 —— 首页一份稿子只出现一次。
 */
export async function listRecipes(skillPath: string | undefined): Promise<Recipe[]> {
  if (!skillPath) return []
  const root = join(skillPath, 'recipes')
  const items: Array<Recipe & { order: number }> = []
  /** 同款样稿用掉的示例目录(真实路径):案例里不再列。 */
  const samples = new Set<string>()
  for (const dir of await subdirs(root)) {
    const text = await readFile(join(root, dir, 'RECIPE.md'), 'utf8').catch(() => '')
    const meta = frontmatter(text)
    if (!meta.id || !meta.title || meta.id !== dir) continue
    if (meta.sample) {
      const sample = await withinSkill(skillPath, resolve(root, dir, meta.sample))
      if (sample) samples.add(sample)
    }
    items.push({
      ...(await card(skillPath, join(root, dir), meta, 'recipe')),
      prompt: recipePrompt({
        id: meta.id,
        title: meta.title,
        summary: meta.summary,
        sample: meta.sample ? skillRelative(dir, meta.sample) : undefined,
        slots: contentSlots(text),
      }),
    })
  }
  const examples = join(skillPath, 'examples')
  for (const dir of await subdirs(examples)) {
    const meta = frontmatter(
      await readFile(join(examples, dir, 'EXAMPLE.md'), 'utf8').catch(() => ''),
    )
    if (!meta.id || !meta.title || meta.id !== dir) continue
    if (items.some((item) => item.id === dir)) continue
    if (samples.has(await realpath(join(examples, dir)).catch(() => ''))) continue
    items.push(await card(skillPath, join(examples, dir), meta, 'example'))
  }
  // 首页的顺序:新上架的在前。frontmatter 的 order 是上架序号(同款和案例一起排),大的在前,没写的排最后,再按目录名
  return items
    .sort((a, b) => b.order - a.order || a.id.localeCompare(b.id))
    .map(({ order: _order, ...item }) => item)
}

/** 同款和案例共有的那几项。 */
async function card(
  skillPath: string,
  home: string,
  meta: Record<string, string>,
  kind: Recipe['kind'],
): Promise<Recipe & { order: number }> {
  const order = Number(meta.order)
  // 封面图(frontmatter 的 poster,相对自己的目录),跟着同款放在 skill 里。
  // 文件不在、或者出了 skill 目录就不给 —— 首页卡片显示占位
  const poster = meta.poster ? await withinSkill(skillPath, resolve(home, meta.poster)) : undefined
  return {
    order: Number.isFinite(order) ? order : -Infinity,
    kind,
    id: meta.id!,
    title: meta.title!,
    mode: meta.mode ?? '汇报稿',
    ...(meta.summary ? { summary: meta.summary } : {}),
    ...(poster ? { poster } : {}),
  }
}

/** 一层子目录,`.` 和 `_` 开头的不算(`examples/_assets` 是共用素材)。目录不在就是空的。 */
async function subdirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'),
      )
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** `sample`(相对配方目录)换成相对 skill 根的路径,提示词里给 agent 用;出了 skill 就不给。 */
function skillRelative(dir: string, sample: string): string | undefined {
  const path = posix.normalize(posix.join('recipes', dir, sample)).replace(/\/$/, '')
  return path.startsWith('..') || posix.isAbsolute(path) ? undefined : path
}

/**
 * 同款样稿(或案例)的入口文件。只认 listRecipes 认得的 id,不拿 id 拼路径去碰别的目录。
 *
 * 样稿可以直接放在配方目录里(`recipes/<id>/index.html`),也可以用 frontmatter 的
 * `sample` 指向 skill 里现成的示例(比如 `sample: ../../examples/drink-showcase`)——
 * 示例还被展示站、测试和规范文档用着,不复制第二份。`sample` 必须落在 skill 目录以内。
 * 案例就是 `examples/<id>/index.html` 本身。
 */
export async function recipeEntry(
  skillPath: string | undefined,
  id: string,
): Promise<RecipeSource | undefined> {
  const known = (await listRecipes(skillPath)).find((item) => item.id === id)
  if (!skillPath || !known) return undefined
  const example = known.kind === 'example'
  const home = join(skillPath, example ? 'examples' : 'recipes', id)
  const meta = frontmatter(await readFile(join(home, example ? 'EXAMPLE.md' : 'RECIPE.md'), 'utf8'))
  const dir =
    !example && meta.sample ? await withinSkill(skillPath, resolve(home, meta.sample)) : home
  if (!dir) return undefined
  const entry = await existing(join(dir, 'index.html'))
  if (!entry) return undefined
  return { kind: known.kind, dir, entry, title: known.title }
}

export interface RecipeSource {
  kind: Recipe['kind']
  dir: string
  entry: string
  title: string
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

/**
 * 配方「内容槽位」表的第一列(槽位名),原样去掉加粗。提示词拿它给用户列清单 ——
 * 只搬运,不改写:槽位怎么取、缺了怎么办仍然只写在配方里。
 */
export function contentSlots(text: string): string[] {
  const section = text.match(/^## 内容槽位\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? ''
  const rows = section.split(/\r?\n/).filter((line) => line.trim().startsWith('|'))
  return (
    rows
      .slice(2) // 表头和分隔行
      // 括号里写的是给 agent 的属性名(`data-recap`),用户看不懂,去掉
      .map((row) =>
        (row.split('|')[1] ?? '')
          .replace(/\*\*/g, '')
          .replace(/（[^）]*`[^）]*）/g, '')
          .trim(),
      )
      .filter(Boolean)
  )
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
