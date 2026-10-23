import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileDigest } from './asset-digest.js'
import { deckRevision } from './decks.js'

/**
 * 页胶片缩略图的缓存。
 *
 * 不缓存的话,每打开一次稿子就把每一页离屏渲一遍,渲完之前左栏一片空白;渲出来的图
 * 也没人再用,越攒越多。和同款样片一样**按内容寻址**:稿子本身(`deckRevision`)加上
 * 它引用的每一个本地文件(引擎、主题、图片)的摘要,再加上渲法的版本。任何一处变了键就变,
 * 不比修改时间。
 *
 * 一份稿子一个目录(按路径取摘要),里面只留最新的一份:
 *
 *   <根>/<稿子>/<键>/0.png 1.png … index.json
 */
export function thumbnailRoot(env = process.env): string {
  return env.ORCA_PPT_THUMBNAIL_DIR ?? join(homedir(), '.orca-ppt', 'thumbnails')
}

/** 渲法变了(比如改成停在页内动画放完那一刻)就加一,旧图全部作废。 */
const RENDER_VERSION = '1'

/** 壳渲到一半的目录带这个后缀,渲完才改名成键。 */
const PARTIAL = '.partial'
/** 渲到一半的目录放多久算是被扔下了(壳崩了、超时了)。 */
const STALE_PARTIAL_MS = 60 * 60 * 1000

export interface ThumbnailSlot {
  /** 这份稿子的缓存目录。 */
  dir: string
  key: string
}

export async function thumbnailSlot(
  deckDir: string,
  entry: string,
  width: number,
  root = thumbnailRoot(),
): Promise<ThumbnailSlot> {
  const hash = createHash('sha256')
    .update(RENDER_VERSION)
    .update('\0')
    .update(String(width))
    .update('\0')
    .update(await deckRevision(deckDir))
  const html = await readFile(entry, 'utf8').catch(() => '')
  for (const ref of localRefs(html)) {
    hash.update('\0').update(ref).update('\0')
    // 引用的文件不在:当它是空的。稿子本身会坏,但那不是缓存该管的事
    hash.update(await fileDigest(resolve(dirname(entry), ref)).catch(() => 'missing'))
  }
  const deck = createHash('sha256').update(resolve(deckDir)).digest('hex').slice(0, 16)
  return { dir: join(root, deck), key: hash.digest('hex').slice(0, 16) }
}

/** 缓存里有就返回每一页的路径;页数对不上、少了文件都当没有。 */
export async function readThumbnails(
  slot: ThumbnailSlot,
  slideCount: number,
): Promise<string[] | undefined> {
  const dir = join(slot.dir, slot.key)
  try {
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as {
      files?: unknown
    }
    if (!Array.isArray(index.files) || index.files.length !== slideCount) return undefined
    const paths = index.files.map((name) => join(dir, basename(String(name))))
    for (const path of paths) if (!(await stat(path)).isFile()) return undefined
    return paths
  } catch {
    return undefined
  }
}

/** 给壳渲图的目录。渲完交给 `storeThumbnails` 改名。 */
export async function partialDir(slot: ThumbnailSlot): Promise<string> {
  const dir = join(slot.dir, `${slot.key}.${randomUUID().slice(0, 8)}${PARTIAL}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 壳渲完了:改名成键,记下每一页的文件,删掉这份稿子的旧缓存。返回最终的路径。
 * 有一页没渲出来就不进缓存 —— 可能只是偶尔失败,不该一直空着那一格。
 */
export async function storeThumbnails(
  slot: ThumbnailSlot,
  partial: string,
  paths: Array<string | null>,
  slideCount: number,
): Promise<Array<string | null>> {
  // 被后来的请求顶掉的那次,壳交回来的是空的;页数对不上也一样不进缓存
  if (paths.length !== slideCount || paths.some((path) => !path)) return paths
  const dir = join(slot.dir, slot.key)
  try {
    await rename(partial, dir)
  } catch {
    // 同一个版本被别的请求先渲好了:用它的,这一份扔掉
    const done = await readThumbnails(slot, paths.length)
    if (done) {
      await rm(partial, { recursive: true, force: true })
      return done
    }
    // 那份是坏的(渲到一半被打断):换成这一份
    await rm(dir, { recursive: true, force: true })
    await rename(partial, dir)
  }
  const files = paths.map((path) => basename(path!))
  await writeFile(join(dir, 'index.json'), JSON.stringify({ files }))
  await prune(slot)
  return files.map((name) => join(dir, name))
}

/** 渲失败了:渲了一半的目录不留。 */
export async function dropPartial(partial: string): Promise<void> {
  await rm(partial, { recursive: true, force: true })
}

/** 这份稿子只留当前这一版;别人正在渲的不动,扔下太久的才删。 */
async function prune(slot: ThumbnailSlot): Promise<void> {
  for (const name of await readdir(slot.dir).catch(() => [] as string[])) {
    if (name === slot.key) continue
    const path = join(slot.dir, name)
    if (name.endsWith(PARTIAL)) {
      const info = await stat(path).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs < STALE_PARTIAL_MS) continue
    }
    await rm(path, { recursive: true, force: true })
  }
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
