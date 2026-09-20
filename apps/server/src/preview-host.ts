import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve, sep } from 'node:path'
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

  /** 处理一个请求。不是预览请求就返回 false,交回给调用方。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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

      res.writeHead(200, {
        'content-type': contentTypeFor(real),
        'content-length': info.size,
        // 稿子在改,画布要看到最新的那一版。
        'cache-control': 'no-store',
      })
      if (req.method === 'HEAD') {
        res.end()
        return true
      }
      createReadStream(real).pipe(res)
    } catch {
      res.writeHead(404).end()
    }
    return true
  }
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}
