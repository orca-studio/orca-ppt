import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * `orca-ppt tools` / `orca-ppt call`:CLI 当 server 的又一个 MCP 客户端。
 *
 * 给配不了 MCP、或者不想在助手里点「信任」的场合:助手跑的只是一条命令,不经过它的连接器。
 * 工具、说明、参数都是 `/mcp` 那一份,这里一个都不另写 —— 界面那边照样框出改动、记成 agent
 * 做的,接管时照样拦。要先有 server 在跑(`orca-ppt serve --detach` 或桌面版)。
 *
 * 本机进程不带 Origin,`/mcp` 不要 token(见 apps/server/src/web-host.ts)。
 */

export interface ToolInfo {
  name: string
  title?: string
  description?: string
  params: Array<{ name: string; type: string; required: boolean; description?: string }>
}

async function connect<T>(port: number, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'orca-ppt-cli', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
  try {
    // as never:SDK 的类型没按 exactOptionalPropertyTypes 写(sessionId?: string 少了 | undefined),
    // 和 apps/server/src/mcp-http.ts 一样的问题
    await client.connect(transport as never)
  } catch (cause) {
    throw new Error(
      `连不上 Orca PPT(127.0.0.1:${port}):先跑 orca-ppt serve --detach,或者打开桌面版。` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    )
  }
  try {
    return await run(client)
  } finally {
    await client.close().catch(() => {})
  }
}

/** 工具清单和 MCP 握手时给的使用说明。 */
export async function listTools(
  port: number,
): Promise<{ instructions: string | undefined; tools: ToolInfo[] }> {
  return connect(port, async (client) => {
    const { tools } = await client.listTools()
    return {
      instructions: client.getInstructions(),
      tools: tools.map((tool) => {
        const schema = tool.inputSchema as {
          properties?: Record<
            string,
            { type?: string | string[]; description?: string; enum?: unknown[] }
          >
          required?: string[]
        }
        return {
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          params: Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
            name,
            type: prop.enum
              ? prop.enum.map(String).join('|')
              : [prop.type ?? 'any'].flat().join('|'),
            required: schema.required?.includes(name) ?? false,
            ...(prop.description ? { description: prop.description } : {}),
          })),
        }
      }),
    }
  })
}

export interface CallResult {
  isError: boolean
  /** 文字内容,按顺序。 */
  text: string[]
  /** 图片内容存成的文件。终端里放不下图,给路径。 */
  images: string[]
}

/** 调一个工具。图片存进临时目录,交回路径。 */
export async function callTool(
  port: number,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  return connect(port, async (client) => {
    const result = await client.callTool({ name, arguments: args })
    const content = (result.content ?? []) as Array<{
      type: string
      text?: string
      data?: string
      mimeType?: string
    }>
    const text: string[] = []
    const images: string[] = []
    for (const item of content) {
      if (item.type === 'text' && item.text !== undefined) text.push(item.text)
      else if (item.type === 'image' && item.data) {
        const dir = join(tmpdir(), 'orca-ppt-cli')
        await mkdir(dir, { recursive: true })
        const file = join(
          dir,
          `${randomUUID().slice(0, 8)}.${item.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
        )
        await writeFile(file, Buffer.from(item.data, 'base64'))
        images.push(file)
      }
    }
    return { isError: Boolean(result.isError), text, images }
  })
}
