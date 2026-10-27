import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwrightRenderer } from './playwright-renderer.js'
import { startServer } from './server.js'
import { defaultWebRoot } from './web-host.js'

/**
 * `orca-ppt serve`:不开桌面版,在浏览器里用工作台。同一个 server,多托管一份界面,
 * 打开浏览器。MCP 照常挂在 `/mcp`,agent 和人在浏览器里协作和桌面版一样。
 *
 * 用法:node apps/server/dist/serve.js [--port 6722] [--deck <稿子目录>] [--no-open]
 *
 * 界面要带对启动 token 才连得上(见 web-host.ts):token 每次启动现生成,写在打开的网址里。
 */
const args = process.argv.slice(2)
const opt = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const port = Number(opt('--port') ?? process.env.ORCA_PPT_PORT ?? 6722)
const deck = opt('--deck')
const token = randomBytes(24).toString('base64url')
const here = dirname(fileURLToPath(import.meta.url))
// 缩略图、导出 PPTX、浏览器里截图:系统 Chrome(没有就 Edge),第一次用时才开
const renderer = playwrightRenderer()

let server: Awaited<ReturnType<typeof startServer>>
try {
  server = await startServer({
    port,
    token,
    webRoot: process.env.ORCA_PPT_WEB_ROOT ?? defaultWebRoot(here),
    // 稿子放到另一个端口(另一个源),界面经 postMessage 叫它做事;guest.js 由界面这个源给
    isolate: { previewPort: 0, guestScript: '/guest.js' },
    renderer,
  })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    process.stderr.write(
      `端口 ${port} 被占了 —— 多半开着 Orca PPT 桌面版或另一个 serve。关掉它,或者用 --port 换一个。\n`,
    )
    process.exit(1)
  }
  throw error
}

const url = new URL(`http://127.0.0.1:${server.port}/`)
url.searchParams.set('token', token)
if (deck) url.searchParams.set('deck', resolve(deck))
process.stdout.write(`orca-ppt serve: ${url.href}\n`)
if (!args.includes('--no-open')) openBrowser(url.href)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all([server.close(), renderer.close()]).then(() => process.exit(0))
  })
}

/** 用系统默认浏览器打开。打不开不算失败:网址已经打出来了,人自己点。 */
function openBrowser(href: string): void {
  const [command, ...rest] =
    process.platform === 'darwin'
      ? ['open', href]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '""', href]
        : ['xdg-open', href]
  try {
    spawn(command!, rest, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref()
  } catch {
    // 同上
  }
}
