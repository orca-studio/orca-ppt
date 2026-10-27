import nodePath from 'node:path'

/**
 * 放映画布要在 loopback 上服务一份 deck。麻烦在于:skill 做出来的稿子引的是
 * `../../node_modules/reveal.js/dist/reveal.js` 和 `../../runtime/tokens.css` ——
 * **资源在 deck 目录之外**。只服务 deck 目录的话,页面能打开但没有 reveal 和主题。
 *
 * 做法:**挂载路径直接镜像绝对文件路径**,`/p/<token>` + `/Users/…/deck.html`。
 * 这样 URL 里的层数和磁盘上的层数一一对应,稿子里的相对引用在浏览器里解析出来的结果,
 * 和它在磁盘上指向的东西完全一致 —— 不管它往上跳两层还是七层。
 *
 * 不改写稿子里的路径:改写了,画布里跑的就不是用户交付的那份文件,「所见即所得」立刻
 * 不成立,而且改写里的一个小错会是隐形的。
 *
 * 之前试过「按逃逸层数倒推一个公共服务根」,对 deck 和 skill 隔得远的情况是错的:
 * 服务根爬不到那么上面(爬上去就等于把家目录挂出去),深引用于是落在挂载路径内部,
 * 全部 404。层数对齐没有这个问题。
 */

export interface PreviewPlan {
  /** 入口文件的绝对路径。 */
  entryFile: string
  /** 这份 deck 允许读的目录(deck 自己)。skill 由 PreviewHost 全局放行。 */
  root: string
  /** 入口文件在挂载下的 URL 路径 —— 就是它的绝对路径。 */
  urlPath: string
}

export function planPreview(deckDir: string, entryFile: string): PreviewPlan {
  return {
    entryFile: nodePath.resolve(entryFile),
    root: nodePath.resolve(deckDir),
    urlPath: toUrlPath(nodePath.resolve(entryFile)),
  }
}

/** 绝对文件路径 → URL 路径。Windows 的盘符当作第一段。 */
export function toUrlPath(absolute: string): string {
  const normalized = absolute.split(nodePath.sep).join('/')
  return normalized.startsWith('/') ? normalized : '/' + normalized
}

/**
 * URL 路径 → 本地文件路径,`toUrlPath` 的反方向。Windows 的 `/C:/a/b.png` 去掉开头的 `/`
 * (不去的话 resolve 出来是 `D:\C:\a\b.png` 这种,什么都对不上);其他平台原样。
 */
export function fromUrlPath(urlPath: string, path: typeof nodePath.win32 = nodePath): string {
  return path.sep === '\\' && /^\/[A-Za-z]:\//.test(urlPath) ? urlPath.slice(1) : urlPath
}

/**
 * URL 路径 → 磁盘路径,并确认它落在允许的目录里。
 *
 * 越界一律拒绝。允许的只有这份 deck 的目录和 skill 目录 —— 这不是一个通用文件服务。
 */
export function resolveWithinRoots(
  roots: string[],
  urlPath: string,
  path: typeof nodePath.win32 = nodePath,
): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '')
  } catch {
    return undefined
  }
  if (decoded.includes('\0') || !decoded.startsWith('/')) return undefined

  const target = path.resolve(fromUrlPath(decoded, path))
  for (const root of roots) {
    const resolvedRoot = path.resolve(root)
    if (target === resolvedRoot || target.startsWith(resolvedRoot + path.sep)) return target
  }
  return undefined
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}
