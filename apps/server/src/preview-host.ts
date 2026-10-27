import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { deckRevision } from '@orca-ppt/deck-core'
import { contentTypeFor, resolveWithinRoots, type PreviewPlan } from './preview.js'

/**
 * 每份打开的 deck 挂在一个不可猜的前缀下:`/p/<token>` + 入口文件的绝对路径。
 *
 * 前缀之后那一截就是真实的绝对路径,所以 URL 层数和磁盘层数一一对应 ——
 * 稿子里的相对引用解析出来指向什么,和它在磁盘上指向什么完全一致(见 preview.ts)。
 */
export class PreviewHost {
  readonly #mounts = new Map<string, PreviewPlan>()
  /** 同一份稿子复用同一个挂载 —— 见 mount()。 */
  readonly #byEntry = new Map<string, { token: string; urlPath: string }>()
  /** 所有 deck 都能读的目录,目前只有 skill(稿子的依赖都在里面)。 */
  readonly #allowRoots: string[] = []
  /**
   * 额外放行的**单个文件**。缩略图和裁切图是壳渲好之后交回来的,散在应用自己的数据
   * 目录里 —— 放行整个目录太宽,只认 server 自己经手过的那几个路径。
   */
  readonly #allowFiles = new Set<string>()
  /** 浏览器版:入口页末尾加一行引它的 `<script>`(见 injectGuest)。桌面版不加。 */
  #guestScript: string | undefined

  /**
   * 浏览器版的稿子在另一个源,界面摸不到页面,检视、改字这些 guest 脚本只能由稿子自己加载:
   * 入口页送出去时在末尾加一行 `<script src>`。磁盘上的文件不动 —— 效果和桌面版 webview
   * 在运行时注入是一样的(见 apps/web/src/guest/bridge.guest.js)。
   */
  injectGuest(url: string): void {
    this.#guestScript = url
  }

  /**
   * 放行一个目录。**要 realpath**:deck 路径是 realpath 过的,allow root 不跟着解析的话,
   * 软链路径下(macOS 的 /var → /private/var 就是)两边不是同一个字符串,
   * 稿子自己的依赖会被判成越界。
   */
  async allow(root: string | undefined): Promise<void> {
    if (!root) return
    let resolved: string
    try {
      resolved = await realpath(root)
    } catch {
      resolved = resolve(root)
    }
    if (!this.#allowRoots.includes(resolved)) this.#allowRoots.push(resolved)
  }

  /**
   * 放行一个具体文件,给 `/asset` 用。
   *
   * 为什么要有这条路:界面在 dev 下是从 `http://localhost:5273` 加载的,而 Chromium
   * 不允许 http 页面加载 `file://` 子资源 —— 缩略图会全裂。打包版页面本身是 file://
   * 所以看不出来,这是个只在 dev 下发作的差异,正好最容易被当成"图没生成"。
   */
  allowFile(path: string | undefined): void {
    if (!path) return
    const target = resolve(path)
    this.#allowFiles.add(target)
    // realpath 也存一份:壳给的路径和解析后的未必是同一个字符串。
    void realpath(target)
      .then((real) => this.#allowFiles.add(real))
      .catch(() => {})
  }

  /**
   * 挂一份 deck。**同一个入口文件复用同一个 token**:每次稿子变动都换一个 URL 的话,
   * 画布只能整页重载(回到第一页),而且旧挂载会一直攒着。
   */
  mount(plan: PreviewPlan): { token: string; urlPath: string } {
    const existing = this.#byEntry.get(plan.entryFile)
    if (existing) {
      this.#mounts.set(existing.token, plan)
      return existing
    }

    const token = randomBytes(9).toString('base64url')
    this.#mounts.set(token, plan)
    const mount = { token, urlPath: `/p/${token}${plan.urlPath}` }
    this.#byEntry.set(plan.entryFile, mount)
    return mount
  }

  unmount(token: string): void {
    const plan = this.#mounts.get(token)
    this.#mounts.delete(token)
    if (plan) this.#byEntry.delete(plan.entryFile)
  }

  /** 处理一个请求。不是预览/资源请求就返回 false,交回给调用方。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const asset = (req.url ?? '').match(/^\/asset(\/.*)$/)
    if (asset?.[1]) return this.#serveAsset(req, res, asset[1])

    const match = (req.url ?? '').match(/^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/)
    if (!match?.[1]) return false

    const plan = this.#mounts.get(match[1])
    if (!plan) {
      res.writeHead(404).end()
      return true
    }

    // GET/HEAD 之外一律拒绝 —— 这是个只读的放映用文件服务,不接受写。
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return true
    }

    const roots = [plan.root, ...this.#allowRoots]
    const target = resolveWithinRoots(roots, match[2] ?? '/')
    if (!target) {
      res.writeHead(403).end()
      return true
    }

    try {
      // 符号链接可以指到允许目录外面,所以解析之后再检一次。
      const real = await realpath(target)
      if (!roots.some((root) => within(resolve(root), real))) {
        res.writeHead(403).end()
        return true
      }

      const info = await stat(real)
      if (!info.isFile()) {
        res.writeHead(404).end()
        return true
      }

      if (real === (await realpath(plan.entryFile))) {
        const before = await deckRevision(plan.root)
        const source = await readFile(real)
        const after = await deckRevision(plan.root)
        // Concurrent writes cannot be labelled as a confirmed version.
        const stable = before === after && source.equals(await readFile(real))
        const bytes = this.#guestScript ? withScript(source, this.#guestScript) : source
        res.writeHead(200, {
          'content-type': contentTypeFor(real),
          'content-length': bytes.length,
          'cache-control': 'no-store',
          ...(stable ? { 'server-timing': `orca-revision;desc="${after}"` } : {}),
        })
        res.end(req.method === 'HEAD' ? undefined : bytes)
        return true
      }
      // 稿子在改,画布要看到最新的那一版。
      sendFile(req, res, real, info.size)
    } catch {
      res.writeHead(404).end()
    }
    return true
  }

  /**
   * 界面要显示的一张本地图:缩略图、裁切图,或者 skill 里示例自带的那张。
   *
   * **先 realpath 再比,不先按字面比**:allow root 是 realpath 过的,而界面拿到的路径
   * 未必是(macOS 的 /var → /private/var 就是),字面比会把自家的文件判成越界。
   * 这个坑在这个仓库里已经踩过三次了 —— deck 根、allow root、模板实例化各一次。
   */
  async #serveAsset(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return true
    }

    let decoded: string
    try {
      decoded = decodeURIComponent(urlPath.split('?')[0] ?? '')
    } catch {
      res.writeHead(400).end()
      return true
    }
    if (decoded.includes('\0') || !decoded.startsWith('/')) {
      res.writeHead(400).end()
      return true
    }

    // `..` 在这里就被 resolve 吃掉了,越界的会落到放行范围之外。
    const target = resolve(assetFilePath(decoded))
    const real = await realpath(target).catch(() => undefined)
    // 文件不在时 realpath 会失败,那就解析它所在的目录 —— 否则「不存在」会被误判成
    // 「越界」,排查时分不清是路径写错了还是权限拦了。
    const probe =
      real ??
      (await realpath(dirname(target))
        .then((dir) => join(dir, basename(target)))
        .catch(() => target))

    const allowed =
      this.#allowFiles.has(probe) ||
      this.#allowFiles.has(target) ||
      this.#allowRoots.some((root) => within(root, probe))
    if (!allowed) {
      res.writeHead(403).end()
      return true
    }
    // 放行了但文件不在 —— 是 404,不是 403。分不清的话排查起来全是猜。
    if (!real) {
      res.writeHead(404).end()
      return true
    }

    try {
      const info = await stat(real)
      if (!info.isFile()) {
        res.writeHead(404).end()
        return true
      }
      // 稿子一改缩略图就重渲,同名不同内容,不能缓存。
      sendFile(req, res, real, info.size)
    } catch {
      res.writeHead(404).end()
    }
    return true
  }
}

/**
 * 回一个文件,认 `Range`。
 *
 * `<video>` 靠它:Chromium 要先探一段、再按需取后面的,`loop` 回到开头也是一次 seek。
 * 不认 Range 时视频照样能「加载」,但不播、不循环 —— 首页样片悬停不动就是这个。
 * 只认单段 `bytes=a-b` / `bytes=a-` / `bytes=-n`,多段请求按整份回。
 */
export function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  size: number,
): void {
  const base = {
    'content-type': contentTypeFor(path),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  const range = parseRange(req.headers.range, size)
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...base, 'content-range': `bytes */${size}` }).end()
    return
  }
  if (range) {
    res.writeHead(206, {
      ...base,
      'content-length': range.end - range.start + 1,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
    })
    if (req.method === 'HEAD') return void res.end()
    createReadStream(path, range).pipe(res)
    return
  }
  res.writeHead(200, { ...base, 'content-length': size })
  if (req.method === 'HEAD') return void res.end()
  createReadStream(path).pipe(res)
}

export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (match[1] === '' && match[2] === '')) return undefined
  let start: number
  let end: number
  if (match[1] === '') {
    // bytes=-n:最后 n 个字节
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/** 在 `</body>` 前(没有就在最后)加一行 `<script src>`。 */
export function withScript(html: Buffer, src: string): Buffer {
  const text = html.toString('utf8')
  const tag = `<script src="${src.replace(/"/g, '&quot;')}"></script>`
  const at = text.toLowerCase().lastIndexOf('</body>')
  return Buffer.from(at === -1 ? text + tag : text.slice(0, at) + tag + text.slice(at), 'utf8')
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * `/asset` 后面那段路径对应的本地文件。界面把 Windows 的 `C:\a\b.png` 写成 `/C:/a/b.png`
 * (apps/web/src/assets.ts),这里去掉开头的 `/`;其他平台原样。
 */
export function assetFilePath(
  urlPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' && /^\/[A-Za-z]:\//.test(urlPath) ? urlPath.slice(1) : urlPath
}
