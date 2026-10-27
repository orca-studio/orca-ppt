import { parentPortRenderer } from './renderer-port.js'
import { startServer } from './server.js'

/**
 * 默认端口是固定的:MCP 的安装命令里要写死这个 URL,端口一变命令就失效。
 * 被占了就如实失败 —— 多半是已经开着一个实例,那正是我们想要的。
 */
const DEFAULT_PORT = 6722

// 桌面版里由主进程的隐藏窗口渲;不在 utilityProcess 里就没有渲染器
const renderer = parentPortRenderer()

const server = await startServer({
  port: process.env.ORCA_PPT_PORT ? Number(process.env.ORCA_PPT_PORT) : DEFAULT_PORT,
  ...(renderer ? { renderer } : {}),
  // 桌面壳生成、经 preload 交给界面;浏览器发来的连接没带对它就拒(见 web-host.ts)
  ...(process.env.ORCA_PPT_TOKEN ? { token: process.env.ORCA_PPT_TOKEN } : {}),
  // 开发时在浏览器里直接开 Vite:稿子放到另一个源,guest.js 由 Vite 给(apps/web/vite.config.ts)
  ...(process.env.ORCA_PPT_GUEST_SCRIPT
    ? { isolate: { previewPort: 0, guestScript: process.env.ORCA_PPT_GUEST_SCRIPT } }
    : {}),
})

// 桌面壳读这一行拿端口。格式别改。
process.stdout.write(`orca-ppt server listening ${server.port}\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0))
  })
}
