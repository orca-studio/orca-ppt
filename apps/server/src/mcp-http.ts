import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ActiveDeck, buildTools, type ProtocolCaller } from './mcp-tools.js'

/**
 * MCP 就挂在这台 server 的 `/mcp` 上,和界面同一个进程、同一个端口。
 *
 * 为什么是 HTTP 不是 stdio:stdio 要在 agent 的配置里写一条指向本仓 dist 的路径
 * (打包之后就废了),还要多起一个进程、再想办法告诉它端口。HTTP 只要一行:
 *
 *   claude mcp add --transport http orca-ppt http://127.0.0.1:6722/mcp
 *
 * 代价是应用必须开着 —— 但本来就必须开着,画布在它里面。
 */
export class McpEndpoint {
  /** 跨请求活着的只有「当前是哪份 deck」。其余每个请求自成一体。 */
  readonly #active = new ActiveDeck()

  constructor(
    private readonly call: ProtocolCaller,
    /** 每次工具被调都报一声,界面据此显示 agent 在线。 */
    private readonly onActivity: (tool: string) => void = () => {},
  ) {}

  /** 处理一个请求。不是 /mcp 就返回 false,交回给调用方。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if ((req.url ?? '').split('?')[0] !== '/mcp') return false

    // 无状态范式:**每个请求新建一套** server + transport。
    // 复用同一个 transport 会让它把响应发到上一个请求的 res 上 —— 第二个请求就静默空回。
    const server = new McpServer({ name: 'orca-ppt', version: '0.1.0' })
    for (const tool of buildTools(this.call, this.#active)) {
      server.registerTool(
        tool.name,
        tool.config as never,
        (async (args: unknown) => tool.run((args ?? {}) as Record<string, unknown>)) as never,
      )
    }

    // 两处 as never 是因为 SDK 的类型没按 exactOptionalPropertyTypes 写(可选属性用
    // `x?: T` 而不是 `x?: T | undefined`)。我们不为此放宽整个仓库的严格度。
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never)
    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport as never)
    await transport.handleRequest(req, res, await readBody(req))
    return true
  }

  async close(): Promise<void> {
    // 每个请求自己收尾,这里没有长驻的东西要关。
  }
}

/** transport 要的是解析好的 JSON body;GET(SSE)没有 body。 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // 交给 transport 去回一个规范的 JSON-RPC 错误。
    return undefined
  }
}
