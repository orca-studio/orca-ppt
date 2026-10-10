import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileDigest } from './asset-digest.js'
import { deckRevision } from './decks.js'

/**
 * 同款样片的缓存。
 *
 * **按内容寻址**:文件名就是缓存键 —— 样稿本身(`deckRevision`:HTML、`.deck/`、`assets/`)
 * 加上它引用的每一个本地 css / js(运行时引擎、tokens、主题、配色)的摘要。
 * 样稿或引擎任何一处变了,键就变,旧样片自然不再命中;不比修改时间,也就不会误判。
 *
 * 放在应用数据目录,不放 skill 目录:发布版里 skill 是 app 包内的只读文件。
 * 每个同款只留最新一份。
 */
export function previewDir(env = process.env): string {
  return env.ORCA_PPT_PREVIEW_DIR ?? join(homedir(), '.orca-ppt', 'recipe-previews')
}

export interface PreviewFiles {
  key: string
  video: string
  poster: string
}

/** 这份样稿此刻对应的缓存文件。文件在不在由调用方查。 */
export async function previewFiles(
  id: string,
  dir: string,
  entry: string,
  /** 录制参数(页范围、封面时间)也算进键:改了 frontmatter 就该重录。 */
  options = '',
  env = process.env,
): Promise<PreviewFiles> {
  const key = await previewKey(dir, entry, options)
  const base = join(previewDir(env), id, key)
  return { key, video: `${base}.webm`, poster: `${base}.jpg` }
}

export async function previewKey(dir: string, entry: string, options = ''): Promise<string> {
  const hash = createHash('sha256')
    .update(await deckRevision(dir))
    .update('\0')
    .update(options)
  const html = await readFile(entry, 'utf8').catch(() => '')
  for (const ref of localRefs(html)) {
    const file = resolve(dirname(entry), ref)
    if (!['.css', '.js', '.mjs'].includes(extname(file))) continue
    hash.update('\0').update(ref).update('\0')
    // 引用的文件不在:当它是空的。稿子本身会坏,但那不是缓存该管的事
    hash.update(await fileDigest(file).catch(() => 'missing'))
  }
  return hash.digest('hex').slice(0, 16)
}

/** 稿子里引用的本地相对路径(href / src)。远程地址、data:、锚点不算。 */
export function localRefs(html: string): string[] {
  const refs = new Set<string>()
  for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"'#?]+)/g)) {
    const ref = match[1]!.trim()
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue
    refs.add(ref)
  }
  return [...refs].sort()
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile() && info.size > 0,
    () => false,
  )
}

/** 录好之后:这个同款目录里只留这一份。 */
export async function pruneOthers(files: PreviewFiles): Promise<void> {
  const dir = dirname(files.video)
  const keep = new Set([files.video, files.poster].map((path) => resolve(path)))
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = resolve(dir, name)
    if (!keep.has(path)) await rm(path, { force: true })
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * 上一份录好的样片(键已经过期)。样稿改了要重录时首页先放它,不让卡片空着;
 * 新的录好后 pruneOthers 会删掉它。
 */
export async function stalePreview(
  files: PreviewFiles,
): Promise<{ preview: string; poster?: string } | undefined> {
  const dir = dirname(files.video)
  const names = await readdir(dir).catch(() => [] as string[])
  const videos = names.filter((name) => name.endsWith('.webm') && join(dir, name) !== files.video)
  for (const name of videos) {
    const video = join(dir, name)
    if (!(await exists(video))) continue
    const poster = video.replace(/\.webm$/, '.jpg')
    return { preview: video, ...((await exists(poster)) ? { poster } : {}) }
  }
  return undefined
}
