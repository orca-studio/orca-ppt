import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { resolve, sep } from 'node:path'
import { contentTypeFor, resolveWithinRoot, type PreviewPlan } from './preview.js'

/**
 * 每份打开的 deck 挂在一个不可猜的前缀下:`/p/<token>/…`。
 *
 * 为什么要前缀而不是把服务根直接挂在 `/`:同时开两份 deck 时它们的服务根不一样,
 * 挂在根上会互相覆盖。前缀是纯路径前缀,稿子里的相对引用照样能解析出来。
 */
export class PreviewHost {
  readonly #mounts = new Map<string, PreviewPlan>()

  mount(plan: PreviewPlan): { token: string; urlPath: string } {
    const token = randomBytes(9).toString('base64url')
    this.#mounts.set(token, plan)
    return { token, urlPath: `/p/${token}${plan.urlPath}` }
  }

  unmount(token: string): void {
    this.#mounts.delete(token)
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

    const target = resolveWithinRoot(plan.serveRoot, match[2] ?? '/')
    if (!target) {
      res.writeHead(403).end()
      return true
    }

    try {
      // 符号链接可以指到根外面,所以解析之后再检一次。
      const real = await realpath(target)
      const root = resolve(plan.serveRoot)
      if (real !== root && !real.startsWith(root + sep)) {
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
