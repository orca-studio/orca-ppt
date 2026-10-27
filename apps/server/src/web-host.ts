import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { contentTypeFor } from './preview.js'

/**
 * `orca-ppt serve` 时由 server 托管界面(`apps/web` 的打包产物),浏览器打开就是工作台。
 * 桌面版不走这里:Electron 直接从本地文件加载界面。
 *
 * 只读、只服务这一个目录;`/p`、`/asset`、`/mcp` 在它前面已经被认领了,不会被这里盖住。
 */
export async function serveWeb(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  let path: string
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  } catch {
    return false
  }
  if (path.includes('\0')) return false
  const base = await realpath(root)
  let target = resolve(base, '.' + (path === '/' ? '/index.html' : path))
  try {
    target = await realpath(target)
  } catch {
    return false
  }
  if (target !== base && !target.startsWith(base + sep)) return false
  const info = await stat(target).catch(() => undefined)
  if (!info?.isFile()) return false
  res.writeHead(200, {
    'content-type': contentTypeFor(target),
    'content-length': info.size,
    // 界面随 server 一起换版本,别让浏览器拿旧的
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(target).pipe(res)
  return true
}

/** 打包产物的默认位置:`apps/server/dist/` 旁边的 `apps/web/dist/`。 */
export const defaultWebRoot = (here: string) => join(here, '../../web/dist')

/**
 * 谁能连上协议的 WebSocket。
 *
 * 浏览器里任何网页都能往 `ws://127.0.0.1:6722` 发连接,所以**带 Origin 的连接(浏览器发的)
 * 必须带对启动 token**,token 由起 server 的那一方交给界面:桌面版经 preload,`serve` 写在
 * 打开的网址里。不带 Origin 的是本机进程(测试、脚本),它们本来就能直接读写稿子目录,
 * 拦它们没有意义。
 *
 * 没配 token(测试)就不拦。
 */
export function allowClient(
  token: string | undefined,
  origin: string | undefined,
  url: string | undefined,
): boolean {
  if (!token || !origin) return true
  let given: string | null
  try {
    given = new URL(url ?? '/', 'http://x').searchParams.get('token')
  } catch {
    return false
  }
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}
