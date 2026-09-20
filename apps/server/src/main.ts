import { startServer } from './server.js'

/**
 * 默认端口是固定的:MCP 的安装命令里要写死这个 URL,端口一变命令就失效。
 * 被占了就如实失败 —— 多半是已经开着一个实例,那正是我们想要的。
 */
const DEFAULT_PORT = 6722

const server = await startServer({
  port: process.env.ORCA_PPT_PORT ? Number(process.env.ORCA_PPT_PORT) : DEFAULT_PORT,
})

// 桌面壳读这一行拿端口。格式别改。
process.stdout.write(`orca-ppt server listening ${server.port}\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0))
  })
}
