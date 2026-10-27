import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { playwrightRenderer } from '@orca-ppt/render'
import { startServer } from './server.js'

/**
 * `orca-ppt serve`:不开桌面版,在浏览器里用工作台。同一个 server,多托管一份界面,
 * 打开浏览器。MCP 照常挂在 `/mcp`,agent 和人在浏览器里协作和桌面版一样。
 *
 * 参数:[--port 6722] [--deck <稿子目录>] [--no-open]
 *
 * 界面要带对启动 token 才连得上(见 web-host.ts):token 每次启动现生成,写在打开的网址里。
 * 起来之后把网址和进程号记进状态文件(serveStatePath),`--detach` 和 `stop` 靠它找到这一个。
 */
export async function serve(args: string[], options: { webRoot: string }): Promise<void> {
  const opt = (name: string): string | undefined => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }

  const port = Number(opt('--port') ?? process.env.ORCA_PPT_PORT ?? 6722)
  const deck = opt('--deck')
  const token = randomBytes(24).toString('base64url')
  // 缩略图、导出 PPTX、浏览器里截图:系统 Chrome(没有就 Edge),第一次用时才开
  const renderer = playwrightRenderer()

  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer({
      port,
      token,
      webRoot: process.env.ORCA_PPT_WEB_ROOT ?? options.webRoot,
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
  const state = serveStatePath()
  await mkdir(dirname(state), { recursive: true })
  // 网址里有 token:只给自己读
  await writeFile(
    state,
    JSON.stringify({ pid: process.pid, port: server.port, url: url.href }) + '\n',
    { mode: 0o600 },
  )
  process.stdout.write(`orca-ppt serve: ${url.href}\n`)
  if (!args.includes('--no-open')) openBrowser(url.href)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void Promise.all([
        server.close(),
        renderer.close(),
        // 只删自己的:别把后来起的那个 serve 的记录删了
        readServeState().then((current) =>
          current?.pid === process.pid ? rm(state, { force: true }) : undefined,
        ),
      ]).then(() => process.exit(0))
    })
  }
}

/** 正在跑的 serve 记在这里:进程号、端口、带 token 的网址。 */
export function serveStatePath(env = process.env): string {
  return env.ORCA_PPT_SERVE_STATE ?? join(homedir(), '.orca-ppt', 'serve.json')
}

export interface ServeState {
  pid: number
  port: number
  url: string
}

/** 读状态文件;那个进程已经不在了就当没有。 */
export async function readServeState(env = process.env): Promise<ServeState | undefined> {
  let state: ServeState
  try {
    state = JSON.parse(await readFile(serveStatePath(env), 'utf8')) as ServeState
  } catch {
    return undefined
  }
  try {
    process.kill(state.pid, 0)
    return state
  } catch {
    return undefined
  }
}

/**
 * 打开工作台:先找 Chrome,再找 Edge,都没有才用系统默认浏览器。
 *
 * 渲染器截图、导出用的就是 Chrome / Edge(Chromium):工作台在同一个内核里看,转场才和截图、导出
 * 对得上 —— 默认浏览器可能是 Safari 或 Firefox。打不开不算失败:网址已经打出来了,人自己点。
 */
function openBrowser(href: string): void {
  const launch = (command: string, rest: string[]) => {
    try {
      spawn(command, rest, { stdio: 'ignore', detached: true, windowsHide: true })
        .on('error', () => {})
        .unref()
    } catch {
      // 同上
    }
  }
  if (process.platform === 'darwin') {
    const app = ['Google Chrome', 'Microsoft Edge'].find((name) =>
      existsSync(`/Applications/${name}.app`),
    )
    return launch('open', app ? ['-a', app, href] : [href])
  }
  if (process.platform === 'win32') {
    const chrome = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ]
      .filter(Boolean)
      .map((dir) => join(dir!, 'Google/Chrome/Application/chrome.exe'))
      .find((file) => existsSync(file))
    // Edge 是 Windows 10/11 自带的;start msedge 走系统登记的应用路径
    return chrome ? launch(chrome, [href]) : launch('cmd', ['/c', 'start', '""', 'msedge', href])
  }
  launch('xdg-open', [href])
}
