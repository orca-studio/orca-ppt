import { randomUUID } from 'node:crypto'
import type { RenderReply, RenderRequest, Renderer } from '@orca-ppt/deck-core'
import { AgentError } from './agent-errors.js'

/**
 * Electron 给 utilityProcess 里的进程挂的 `process.parentPort`。server 不 import electron,
 * 所以自己写这几个用得到的方法。
 */
interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  postMessage(message: unknown): void
}

/** 一份稿子每页渲一张,比单张截图慢得多,给足时间。 */
const THUMBNAILS_TIMEOUT = 90_000
/** 导出 PPTX 要逐页渲染、截图。 */
const PPTX_TIMEOUT = 300_000

/**
 * 桌面版:server 跑在 Electron 的 utilityProcess 里,经 parentPort 找主进程的隐藏窗口渲。
 * 不经过界面 —— 窗口关了、界面断了,渲染照样能做。
 *
 * 不在 utilityProcess 里(测试、以后的 `orca-ppt serve`)就返回 undefined,由调用方换别的渲染器。
 */
export function parentPortRenderer(
  port: ParentPort | undefined = (process as { parentPort?: ParentPort }).parentPort,
): Renderer | undefined {
  if (!port) return undefined
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  port.on('message', ({ data }) => {
    const reply = data as RenderReply
    const waiting = pending.get(reply?.id)
    if (!waiting) return
    pending.delete(reply.id)
    clearTimeout(waiting.timer)
    if (reply.error !== undefined) waiting.reject(new Error(reply.error))
    else waiting.resolve(reply.value)
  })

  const call = (request: Omit<RenderRequest, 'id'>, timeoutMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('渲染超时'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      port.postMessage({ ...request, id })
    })

  return {
    thumbnails: async (job) =>
      (await call({ method: 'thumbnails', job }, THUMBNAILS_TIMEOUT)) as Array<string | null>,
    exportPptx: (job) => call({ method: 'exportPptx', job }, PPTX_TIMEOUT),
  }
}

/** 没有浏览器可用的运行环境:要渲的一律说清楚做不了,不假装成功。 */
export const noRenderer: Renderer = {
  thumbnails: () => Promise.reject(new Error(AgentError.noRenderer())),
  exportPptx: () => Promise.reject(new Error(AgentError.noRenderer())),
}
