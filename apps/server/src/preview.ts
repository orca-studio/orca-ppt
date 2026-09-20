import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * 放映画布要在 loopback 上服务一份 deck。麻烦在于:skill 做出来的稿子引的是
 * `../../node_modules/reveal.js/dist/reveal.js` 和 `../../runtime/tokens.css` ——
 * **资源在 deck 目录之外**。只服务 deck 目录的话,页面能打开但没有 reveal 和主题。
 *
 * 所以这里按稿子**实际**逃逸的层数倒推服务根,而不是改写用户的 HTML。改写是另一条路,
 * 但那样画布里跑的就不是用户交付的那份文件了,「所见即所得」立刻不成立。
 */

export interface PreviewPlan {
  /** HTTP 文档根。 */
  serveRoot: string
  /** 入口文件的绝对路径。 */
  entryFile: string
  /** 入口文件在文档根下的 URL 路径。 */
  urlPath: string
  escapeDepth: number
}

/** 逃逸层数的上限。超过这个数说明稿子的引用方式不对,而不是我们该往上服务更多目录。 */
const MAX_ESCAPE_DEPTH = 4

/**
 * 稿子引用的相对路径里,最多往上跳几层。
 *
 * 绝对 URL(https:、//、data:、以 / 开头)不参与 —— 它们不落在本地文件系统上。
 * 主题 CSS 里的字体是 Google Fonts 的 https 链接,所以 CSS 不会再往上逃逸一层。
 */
export function maxEscapeDepth(html: string): number {
  let depth = 0
  const references = html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"|url\(\s*["']?([^"')]+)/g)
  for (const match of references) {
    const raw = match[1] ?? match[2]
    if (!raw) continue
    if (/^(?:[a-z]+:|\/\/|\/|#|data:)/i.test(raw)) continue

    let climbed = 0
    for (const segment of raw.split('/')) {
      if (segment === '..') climbed += 1
      else break
    }
    depth = Math.max(depth, climbed)
  }
  return depth
}

/**
 * 服务根不能是家目录或更上层 —— 那等于把整个家目录挂在 loopback 上。
 * 真撞上了就如实报错,不要偷偷降级到一个跑不起来的根。
 */
export function isUnsafeServeRoot(root: string): boolean {
  const resolved = resolve(root)
  const home = resolve(homedir())
  if (resolved === home || home.startsWith(resolved + sep) || resolved === sep) return true
  return resolved.split(sep).filter(Boolean).length < 2
}

export function planPreview(deckDir: string, entryFile: string, html: string): PreviewPlan {
  const depth = maxEscapeDepth(html)
  if (depth > MAX_ESCAPE_DEPTH) {
    throw new Error(`稿子往上引用了 ${depth} 层,超过上限 ${MAX_ESCAPE_DEPTH} —— 检查一下引用路径`)
  }

  let serveRoot = resolve(deckDir)
  for (let i = 0; i < depth; i += 1) serveRoot = dirname(serveRoot)

  if (isUnsafeServeRoot(serveRoot)) {
    throw new Error(
      `这份稿子的资源要服务到 ${serveRoot},范围太大 —— 把 deck 放进一个工程目录再打开`,
    )
  }

  const urlPath = '/' + relative(serveRoot, entryFile).split(sep).join('/')
  return { serveRoot, entryFile, urlPath, escapeDepth: depth }
}

/**
 * URL 路径 → 磁盘路径。越界一律拒绝:解码后仍要落在文档根内部,
 * 符号链接也要在解析之后再检一次(调用方负责 realpath)。
 */
export function resolveWithinRoot(serveRoot: string, urlPath: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '')
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined

  const root = resolve(serveRoot)
  const target = resolve(join(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded)))
  return target === root || target.startsWith(root + sep) ? target : undefined
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
