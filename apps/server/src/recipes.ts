import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
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

  const recipes: Recipe[] = []
  for (const dir of dirs) {
    const text = await readFile(join(root, dir, 'RECIPE.md'), 'utf8').catch(() => '')
    const meta = frontmatter(text)
    if (!meta.id || !meta.title || meta.id !== dir) continue
    recipes.push({
      id: meta.id,
      title: meta.title,
      mode: meta.mode ?? '汇报稿',
      ...(meta.summary ? { summary: meta.summary } : {}),
      prompt: recipePrompt({ id: meta.id, title: meta.title, summary: meta.summary }),
    })
  }
  return recipes
}

/** 同款样稿的入口文件。只认 listRecipes 认得的 id,不拿 id 拼路径去碰别的目录。 */
export async function recipeEntry(
  skillPath: string | undefined,
  id: string,
): Promise<{ dir: string; entry: string; title: string; coverAt: number | undefined } | undefined> {
  const known = (await listRecipes(skillPath)).find((item) => item.id === id)
  if (!skillPath || !known) return undefined
  const dir = join(skillPath, 'recipes', id)
  const entry = await existing(join(dir, 'index.html'))
  if (!entry) return undefined
  // 封面取第几秒(frontmatter 的 cover)。写错了不猜,交给录制器取默认
  const cover = Number(frontmatter(await readFile(join(dir, 'RECIPE.md'), 'utf8')).cover)
  return { dir, entry, title: known.title, coverAt: Number.isFinite(cover) ? cover : undefined }
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
