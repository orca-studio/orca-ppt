import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/**
 * 新建稿子从哪儿起头。两类,都来自 skill:
 *
 * - **空白模板** `templates/*.html`:汇报稿和故事稿的起始文件,里面是 `{{ROOT}}` 占位符。
 * - **示例** `examples/*`:能直接放映的成稿,每份都带 `thumb.jpg`(skill 自己生成的),
 *   所以缩略图是现成的,不用我们再渲一轮。
 *
 * 两类都能复制到任何地方 —— 它们引到 deck 目录之外的只有 skill 自己(reveal、gsap、
 * runtime),重写一次相对前缀就行。不重写的话,稿子一挪位置就全白。
 */

export interface DeckTemplate {
  id: string
  kind: 'template' | 'example'
  title: string
  /** 缩略图的绝对路径。空白模板没有。 */
  thumbnail?: string
}

const BLANKS: Array<{ file: string; title: string }> = [
  { file: 'starter.html', title: '汇报稿' },
  { file: 'story-starter.html', title: '故事稿' },
]

export async function listTemplates(skillPath: string | undefined): Promise<DeckTemplate[]> {
  if (!skillPath) return []

  const blanks: DeckTemplate[] = []
  for (const blank of BLANKS) {
    try {
      await stat(join(skillPath, 'templates', blank.file))
      blanks.push({ id: `template:${blank.file}`, kind: 'template', title: blank.title })
    } catch {
      // skill 里没有这份模板
    }
  }

  return [...blanks, ...(await listExamples(skillPath))]
}

async function listExamples(skillPath: string): Promise<DeckTemplate[]> {
  const root = join(skillPath, 'examples')
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }

  const examples: DeckTemplate[] = []
  for (const name of names.sort()) {
    // `_assets`、`_tests` 这类内部目录不是示例
    if (name.startsWith('_') || name.startsWith('.')) continue
    const dir = join(root, name)
    let html: string
    try {
      html = await readFile(join(dir, 'index.html'), 'utf8')
    } catch {
      continue
    }

    const thumb = join(dir, 'thumb.jpg')
    const hasThumb = await stat(thumb).then(
      () => true,
      () => false,
    )
    examples.push({
      id: `example:${name}`,
      kind: 'example',
      title: titleOf(html) ?? name,
      ...(hasThumb ? { thumbnail: thumb } : {}),
    })
  }
  return examples
}

/** 稿子的 `<title>`,取 `·` 之前那一段 —— 后面挂的是主题名和版式,列表里太长。 */
function titleOf(html: string): string | undefined {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i)
  const full = match?.[1]?.replace(/\s+/g, ' ').trim()
  return full ? decodeEntities((full.split('·')[0] ?? full).trim()) : undefined
}

/** `<title>` 里是转义过的。不解码的话列表里会出现「Studio &amp; Salon」。 */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity)
}

/** 录制产物和缩略图不该跟着复制到新稿子里。 */
const SKIP = new Set(['index.mp4', 'thumb.jpg', 'deck.mp4'])

/**
 * 按模板建出一份新稿子,返回入口文件路径。
 *
 * 路径重写是关键:模板里的 `{{ROOT}}` 和示例里的 `../../` 都指着 skill 根目录,
 * 而新稿子可能放在磁盘上任何地方。
 */
export async function instantiate(options: {
  skillPath: string
  templateId: string
  targetDir: string
}): Promise<string> {
  const { skillPath, templateId, targetDir } = options
  const [kind, name] = splitId(templateId)
  await mkdir(join(targetDir, '.deck'), { recursive: true })

  /*
   * 算相对路径之前两边都要 realpath。
   *
   * 少了这一步,稿子放在软链路径下时(macOS 的 /tmp → /private/tmp 就是)层数会差一级,
   * 重写出来的路径解析到一个不存在的地方 —— 而且**入口页照样 200**,只有资源全白,
   * 最难发现的那种坏法。
   */
  const realTarget = await realpath(targetDir)
  const realSkill = await realpath(skillPath)
  const toSkill = relative(realTarget, realSkill).split(sep).join('/')
  const entry = join(targetDir, 'deck.html')

  if (kind === 'template') {
    const source = await readFile(join(skillPath, 'templates', name), 'utf8')
    await writeFile(entry, source.split('{{ROOT}}').join(toSkill))
    return entry
  }

  const dir = join(skillPath, 'examples', name)
  for (const file of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(file.name)) continue
    if (file.isDirectory()) {
      await copyDir(join(dir, file.name), join(targetDir, file.name))
      continue
    }
    if (file.name === 'index.html') continue
    await copyFile(join(dir, file.name), join(targetDir, file.name))
  }

  const html = await readFile(join(dir, 'index.html'), 'utf8')
  await writeFile(entry, rewriteRoot(html, toSkill))
  return entry
}

/** 示例都住在 `examples/<名字>/`,所以它们引 skill 的前缀固定是 `../../`。 */
export function rewriteRoot(html: string, toSkill: string): string {
  return html.replace(/(["'])\.\.\/\.\.\//g, `$1${toSkill}/`)
}

function splitId(id: string): ['template' | 'example', string] {
  const at = id.indexOf(':')
  const kind = id.slice(0, at)
  if (kind !== 'template' && kind !== 'example') throw new Error(`不认识的模板:${id}`)
  return [kind, id.slice(at + 1)]
}

async function copyDir(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyDir(join(from, entry.name), join(to, entry.name))
    else await copyFile(join(from, entry.name), join(to, entry.name))
  }
}
