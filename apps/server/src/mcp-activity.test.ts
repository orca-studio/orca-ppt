import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startServer, type OrcaServer } from './server.js'
import type { McpActivity } from './mcp-http.js'

/**
 * agent 活动的端到端:真的打一次 MCP 请求,看界面那头收到什么。
 *
 * 单测各测各的时,「工具报告了」和「界面收得到」之间那道缝最容易漏 —— onActivity
 * 就曾经声明了却从来没被调用过,「agent 在线」因此一直是死的,而两边的单测都绿着。
 */

let server: OrcaServer
let socket: WebSocket
let activity: McpActivity[]

beforeEach(async () => {
  server = await startServer()
  socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
  await new Promise((done) => socket.once('open', done))
  activity = []
  socket.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString())
    if (message.channel === 'mcp.activity') activity.push(message.data)
  })
})

afterEach(async () => {
  socket.close()
  await server.close()
})

function call(method: string, params: unknown): Promise<any> {
  const id = Math.random().toString(36).slice(2)
  return new Promise((resolve) => {
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.id !== id) return
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** 打一次真的 MCP 请求。走 HTTP,和 agent 用的是同一条路。 */
async function mcp(method: string, params: unknown): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return response.text()
}

async function openedDeck(html: string) {
  const dir = await mkdtemp(join(tmpdir(), 'deck-'))
  await writeFile(join(dir, 'deck.html'), html)
  await call('deck.open', { path: dir })
  await mcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })
  return dir
}

/** 推送是异步广播的,等它落地。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

describe('agent 开稿子', () => {
  it('推 deck.opened,界面跟着开 —— 不然画布没加载,它接着截图只会等到超时', async () => {
    const opened: any[] = []
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.channel === 'deck.opened') opened.push(message.data)
    })
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await writeFile(join(dir, 'deck.html'), '<div class="slides"><section>1</section></div>')
    await call('deck.open', { path: dir })
    await settle()
    expect(opened).toHaveLength(1)
    expect(opened[0].path).toContain('deck-')
  })
})

describe('agent 活动', () => {
  it('一次工具调用推两条:跑之前和跑之后', async () => {
    await openedDeck('<div class="slides"><section><p>一</p></section></div>')
    await mcp('tools/call', { name: 'show_slide', arguments: { index: 2 } })
    await settle()

    expect(activity.map((a) => a.phase)).toEqual(['start', 'done'])
    // start 必须在工具跑之前 —— capture_slide 会把画布跳到另一页,
    // 不先说一声的话,人看着画布莫名其妙翻页。
    expect(activity[0]!.at).toBeLessThanOrEqual(activity[1]!.at)
    // 同一次调用的两条要能配对。
    expect(activity[0]!.id).toBe(activity[1]!.id)
  })

  it('带着人话和页号,界面不用自己猜', async () => {
    await openedDeck('<div class="slides"><section><p>一</p></section></div>')
    await mcp('tools/call', { name: 'show_slide', arguments: { index: 3 } })
    await settle()
    expect(activity[0]).toMatchObject({
      tool: 'show_slide',
      kind: 'read',
      label: '让你看第 4 页',
      slides: [3],
    })
  })

  it('改稿子算「写」—— 高亮要和「读」分开', async () => {
    await openedDeck('<div class="slides"><section><p>走过的四站。</p></section></div>')
    await mcp('tools/call', {
      name: 'edit_text',
      arguments: { slide: 0, old_text: '走过的四站。', new_text: '四站,一年' },
    })
    await settle()
    expect(activity[0]).toMatchObject({ kind: 'write', label: '改第 1 页的文字', slides: [0] })
    expect(activity[1]!.error).toBeUndefined()
  })

  it('改字带上刚写进去的文字 —— 界面靠它在画布上点亮那一处', async () => {
    await openedDeck('<div class="slides"><section><p>走过的四站。</p></section></div>')
    await mcp('tools/call', {
      name: 'edit_text',
      arguments: { slide: 0, old_text: '走过的四站。', new_text: '四站,一年' },
    })
    await settle()
    expect(activity[1]).toMatchObject({ kind: 'write', hint: '四站,一年' })
  })

  it('读操作不带线索 —— 没有哪一处可点', async () => {
    await openedDeck('<div class="slides"><section><p>一</p></section></div>')
    await mcp('tools/call', { name: 'show_slide', arguments: { index: 0 } })
    await settle()
    expect(activity[0]!.hint).toBeUndefined()
  })

  it('工具拒绝了就报没办成 —— 报成功是不诚实的', async () => {
    await openedDeck('<div class="slides"><section><p>现在的文字</p></section></div>')
    await mcp('tools/call', {
      name: 'edit_text',
      arguments: { slide: 0, old_text: '根本不存在的文字', new_text: 'x' },
    })
    await settle()
    expect(activity[1]!.error).toContain('找不到那段文字')
  })

  it('工具抛错也照报,不会只剩一条 start 吊在那儿', async () => {
    // 没打开任何 deck:工具自己会抛。
    await mcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    await mcp('tools/call', { name: 'deck_status', arguments: {} })
    await settle()
    expect(activity.map((a) => a.phase)).toEqual(['start', 'done'])
    expect(activity[1]!.error).toBeTruthy()
  })

  it('说不准是哪一页时不给页号 —— 宁可不高亮,也别高亮错的那页', async () => {
    await openedDeck('<div class="slides"><section><p>一</p></section></div>')
    await mcp('tools/call', { name: 'list_themes', arguments: {} })
    await settle()
    expect(activity[0]!.slides).toEqual([])
  })
})

describe('自报家门', () => {
  it('initialize 带上应用图标 —— 宿主拿不到 .app 时只能靠它', async () => {
    const body = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    const line = body.split('\n').find((l) => l.startsWith('data:')) ?? body
    const info = JSON.parse(line.replace(/^data:/, '')).result.serverInfo
    expect(info.title).toBe('OrcaPPT')
    expect(info.icons[0].mimeType).toBe('image/png')
    expect(info.icons[0].src).toMatch(/^data:image\/png;base64,iVBORw0KGgo/)
  })
})
