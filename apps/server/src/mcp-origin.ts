import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 这次协议调用是不是经 MCP 来的、是哪个工具。
 *
 * 界面和 MCP 调的是同一批协议方法(见 mcp-tools.ts),方法本身分不出是谁调的;
 * 操作记录却要写 actor(人 / agent)和触发它的工具名 —— 宿主靠工具名把事件和自己的
 * 调用记录对上。用异步上下文带过去,就不用给每个方法都加一个「是谁」的参数。
 */
export const mcpCall = new AsyncLocalStorage<{ tool: string }>()
