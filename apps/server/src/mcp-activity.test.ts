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
/** 界面收到的「跟上这一处改动」,带收到的时刻。 */
let follows: Array<{ at: number; data: any }>
/** 假界面跟上改动后交回的位置:画布可见。 */
const FOLLOWED = (query: unknown) => ({
  measuredAt: 1,
  coordinateSpace: 'screen_points_top_left',
  targets: [
    {
      query,
      status: 'visible',
      targetId: 'canvas',
      rect: { x: 10, y: 20, width: 300, height: 200 },
    },
  ],
})

beforeEach(async () => {
  server = await startServer()
  socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
  await new Promise((done) => socket.once('open', done))
  activity = []
  follows = []
  socket.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString())
    if (message.channel === 'mcp.activity') activity.push(message.data)
    // 像真的界面一样跟上 agent 的改动,不然 server 要等到超时
    if (message.channel === 'edit.follow') {
      follows.push({ at: Date.now(), data: message.data })
      socket.send(
        JSON.stringify({
          id: `follow-${message.data.requestId}`,
          method: 'edit.followed',
          params: {
            requestId: message.data.requestId,
            targets: FOLLOWED({ controlId: 'canvas' }),
          },
        }),
      )
    }
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
    expect(info.title).toBe('Orca PPT')
    expect(info.icons[0].mimeType).toBe('image/png')
    expect(info.icons[0].src).toMatch(/^data:image\/png;base64,iVBORw0KGgo/)
  })
})

describe('agent 拿着稿子时,界面只读', () => {
  async function openForEdit(text: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await writeFile(
      join(dir, 'deck.html'),
      `<div class="slides"><section><p>${text}</p></section></div>`,
    )
    const opened = await call('deck.open', { path: dir })
    await mcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    return opened.data.deck.id
  }

  const tool = (name: string, args: Record<string, unknown> = {}) =>
    mcp('tools/call', { name, arguments: args })

  it('agent 刚动过,人改字被拒,理由里说得出它在干什么', async () => {
    const deckId = await openForEdit('走过的四站。')
    await tool('show_slide', { index: 0 })

    const response = await call('deck.editText', {
      deckId,
      slide: 0,
      oldText: '走过的四站。',
      newText: '四站',
    })
    expect(response.data).toMatchObject({ ok: false })
    expect(response.data.reason).toContain('让你看第 1 页')
  })

  it('撤销也一样拦 —— 菜单里的 ⌘Z 不走按钮,拦在协议层才拦得住', async () => {
    const deckId = await openForEdit('一')
    await tool('show_slide', { index: 0 })
    const response = await call('deck.undo', { deckId })
    expect(response.data.ok).toBe(false)
    expect(response.data.reason).toContain('agent')
  })

  it('agent 自己的调用不受影响', async () => {
    await openForEdit('走过的四站。')
    await tool('show_slide', { index: 0 })
    await tool('edit_text', { slide: 0, old_text: '走过的四站。', new_text: '四站,一年' })
    await settle()
    expect(activity.at(-1)!.error).toBeUndefined()
  })

  it('界面连上时能问到归谁,换人时会推 control.changed', async () => {
    const changes: any[] = []
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.channel === 'control.changed') changes.push(message.data)
    })
    expect((await call('control.state', {})).data).toEqual({ holder: 'none', explicit: false })

    await openForEdit('一')
    await tool('show_slide', { index: 0 })
    await settle()
    expect(changes[0]).toMatchObject({ holder: 'agent' })
    expect((await call('control.state', {})).data.holder).toBe('agent')
  })
})

describe('握手:agent 明说拿起、交还,人能接管', () => {
  async function openForEdit(text: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await writeFile(
      join(dir, 'deck.html'),
      `<div class="slides"><section><p>${text}</p></section></div>`,
    )
    const opened = await call('deck.open', { path: dir })
    await mcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    return opened.data.deck.id
  }

  const tool = (name: string, args: Record<string, unknown> = {}) =>
    mcp('tools/call', { name, arguments: args })

  const edit = (deckId: string, oldText: string, newText: string) =>
    call('deck.editText', { deckId, slide: 0, oldText, newText })

  it('握手时就告诉宿主先 take_control —— 不然 agent 不会调,遮罩只在每次调用前后闪一下', async () => {
    const reply = await mcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(reply).toContain('"instructions"')
    expect(reply).toContain('take_control')
    expect(reply).toContain('USER_IN_CONTROL')
    expect(reply).toContain('USER_STOPPED')
    // 改稿流程也要交代:原文从 deck_status 抄,别照屏幕抄
    expect(reply).toContain('deck_status')
  })

  it('take_control 之后人改不了,hand_off 之后能改,留的话界面拿得到', async () => {
    const deckId = await openForEdit('一')
    await tool('take_control', { reason: '重排标题' })
    expect((await call('control.state', {})).data).toMatchObject({
      holder: 'agent',
      explicit: true,
      task: '重排标题',
    })
    expect((await edit(deckId, '一', '二')).data.reason).toContain('重排标题')

    await tool('hand_off', { message: '标题请你看一眼' })
    expect((await call('control.state', {})).data).toMatchObject({
      holder: 'none',
      message: '标题请你看一眼',
    })
    expect((await edit(deckId, '一', '二')).data.ok).toBe(true)
  })

  it('人接管之后,agent 的工具收到硬停止,而且不报活动', async () => {
    await openForEdit('一')
    await call('control.takeOver', {})
    activity.length = 0

    const refused = await tool('edit_text', { slide: 0, old_text: '一', new_text: '二' })
    expect(refused).toContain('USER_IN_CONTROL')
    expect(refused).toContain('不要重试')
    await settle()
    expect(activity).toHaveLength(0)
  })

  it('人接管期间 take_control 仍然放行 —— 用户在对话里说了继续,agent 要能拿回来', async () => {
    await openForEdit('一')
    await call('control.takeOver', {})
    await tool('take_control', { reason: '接着改' })
    expect((await call('control.state', {})).data.holder).toBe('agent')
    expect(await tool('show_slide', { index: 0 })).not.toContain('USER_IN_CONTROL')
  })

  it('人按停止之后,agent 的工具收到 USER_STOPPED —— 宿主认出它就中断这一轮', async () => {
    await openForEdit('一')
    await tool('take_control', { reason: '重排' })
    await call('control.stop', {})
    expect((await call('control.state', {})).data).toMatchObject({
      holder: 'user',
      stopped: true,
      task: '重排',
    })
    const refused = await tool('show_slide', { index: 0 })
    expect(refused).toContain('USER_STOPPED')
    expect(refused).not.toContain('USER_IN_CONTROL')
  })

  it('take_control 带 waiting,界面拿得到「在等批准什么」', async () => {
    await openForEdit('一')
    await tool('take_control', { reason: '清理稿子', waiting: '删掉第 5 页' })
    expect((await call('control.state', {})).data).toMatchObject({
      task: '清理稿子',
      waiting: '删掉第 5 页',
    })
    await tool('take_control', { reason: '清理稿子' })
    expect((await call('control.state', {})).data.waiting).toBeUndefined()
  })

  it('人交还之后 agent 又能动了', async () => {
    await openForEdit('一')
    await call('control.takeOver', {})
    await call('control.release', {})
    expect(await tool('show_slide', { index: 0 })).not.toContain('USER_IN_CONTROL')
  })
})

describe('可录制应用约定:操作记录', () => {
  async function openDeckAt(text: string) {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await writeFile(
      join(dir, 'deck.html'),
      `<div class="slides"><section><p>封面</p></section><section><p>${text}</p></section></div>`,
    )
    const opened = await call('deck.open', { path: dir })
    await mcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    return { dir, deckId: opened.data.deck.id as string }
  }

  const tool = (name: string, args: Record<string, unknown> = {}) =>
    mcp('tools/call', { name, arguments: args })

  /** 现在最新的游标:之后的事件才是这个用例产生的。 */
  const cursorNow = async () =>
    (await call('recording.events', { limit: 1000 })).data.cursor as string
  const eventsAfter = async (after: string) =>
    (await call('recording.events', { after })).data.events as any[]

  it('人在界面改字记成 user,改完的版本号和 deck_status 报的一致', async () => {
    const { deckId } = await openDeckAt('走过的四站。')
    const cursor = await cursorNow()
    await call('deck.editText', { deckId, slide: 1, oldText: '走过的四站。', newText: '四站' })

    const [event] = await eventsAfter(cursor)
    expect(event).toMatchObject({
      actor: 'user',
      document: { id: deckId },
      target: { kind: 'slide', index: 1, label: '第 2 页' },
      detail: { oldText: '走过的四站。', newText: '四站' },
    })
    expect(event.tool).toBeUndefined()
    expect(await tool('deck_status')).toContain(event.revision)
  })

  it('agent 经 MCP 改字记成 agent,带上工具名 —— 宿主靠它和自己的调用对上', async () => {
    await openDeckAt('走过的四站。')
    const cursor = await cursorNow()
    await tool('edit_text', { slide: 1, old_text: '走过的四站。', new_text: '四站' })
    const [event] = await eventsAfter(cursor)
    expect(event).toMatchObject({ actor: 'agent', tool: 'edit_text', target: { index: 1 } })
  })

  it('agent 改字:画布跟到那一页、点亮新文字;回执和事件都带上位置', async () => {
    await openDeckAt('走过的四站。')
    const cursor = await cursorNow()
    const receipt = await tool('edit_text', {
      slide: 1,
      old_text: '走过的四站。',
      new_text: '四站',
    })
    expect(follows).toHaveLength(1)
    expect(follows[0]!.data).toMatchObject({ slide: 1, text: '四站', holdMs: 0 })
    const [event] = await eventsAfter(cursor)
    const expected = FOLLOWED({ controlId: 'canvas' }).targets.map((t) => ({ ...t, measuredAt: 1 }))
    expect(event.uiTargets).toEqual(expected)
    // 回执第二段固定是 {"uiTargets":[…]}:录屏宿主拿它当这一步的目标框
    const body = receipt
      .split('\n')
      .find((line) => line.startsWith('data: '))!
      .slice(6)
    expect(JSON.parse(JSON.parse(body).result.content[1].text)).toEqual({ uiTargets: expected })
  })

  it('人在界面上改的不用跟:画布本来就在他眼前', async () => {
    const { deckId } = await openDeckAt('一')
    const cursor = await cursorNow()
    await call('deck.editText', { deckId, slide: 1, oldText: '一', newText: '二' })
    expect(follows).toHaveLength(0)
    const [event] = await eventsAfter(cursor)
    expect(event.uiTargets).toBeUndefined()
  })

  it('演示模式:并发来的改动排成队,每条显示出来之后停一会儿再做下一条', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await writeFile(
      join(dir, 'deck.html'),
      '<div class="slides"><section><p>甲</p></section><section><p>乙</p></section></div>',
    )
    await call('deck.open', { path: dir })
    await mcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    await call('demo.set', { on: true, intervalMs: 300 })
    await Promise.all([
      tool('edit_text', { slide: 0, old_text: '甲', new_text: '一' }),
      tool('edit_text', { slide: 1, old_text: '乙', new_text: '二' }),
    ])
    await call('demo.set', { on: false })
    expect(follows.map((f) => f.data.holdMs)).toEqual([300, 300])
    expect(follows[1]!.at - follows[0]!.at).toBeGreaterThanOrEqual(290)
  })

  it('录制工具不算 agent 的操作:不锁画布、不报活动,也不记成事件', async () => {
    await openDeckAt('一')
    await settle()
    await call('control.release', {})
    activity.length = 0
    const cursor = await cursorNow()

    await tool('recording_events', {})
    await settle()
    expect((await call('control.state', {})).data.holder).toBe('none')
    expect(activity).toHaveLength(0)
    expect(await eventsAfter(cursor)).toHaveLength(0)
  })

  it('人接管了,宿主照样能取记录', async () => {
    await openDeckAt('一')
    await call('control.takeOver', {})
    expect(await tool('recording_events', {})).not.toContain('USER_IN_CONTROL')
    await call('control.release', {})
  })

  it('文件在外面被改,记成 external;我们自己写的不会被当成外面改的', async () => {
    const { dir, deckId } = await openDeckAt('一')
    const cursor = await cursorNow()
    await call('deck.editText', { deckId, slide: 1, oldText: '一', newText: '二' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect((await eventsAfter(cursor)).map((e) => e.actor)).toEqual(['user'])

    await writeFile(
      join(dir, 'deck.html'),
      '<div class="slides"><section><p>封面</p></section><section><p>三</p></section></div>',
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    const events = await eventsAfter(cursor)
    expect(events.map((e) => e.actor)).toEqual(['user', 'external'])
    expect(events[1]).toMatchObject({ summary: '文件在外部被修改', document: { id: deckId } })
  })

  it('缩略图:离屏渲被改的那一页,带宽度;旧版本 REVISION_UNAVAILABLE', async () => {
    const { deckId } = await openDeckAt('一')
    await call('deck.editText', { deckId, slide: 1, oldText: '一', newText: '二' })

    // 扮演界面:收到渲缩略图的请求,交回一张图
    const png = join(await mkdtemp(join(tmpdir(), 'thumb-')), '1.png')
    await writeFile(png, Buffer.from('89504e470d0a1a0a', 'hex'))
    const requests: any[] = []
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.channel !== 'thumbnails.request') return
      requests.push(message.data)
      socket.send(
        JSON.stringify({
          id: 'thumb',
          method: 'thumbnails.result',
          params: { requestId: message.data.requestId, paths: [png] },
        }),
      )
    })

    const reply = await tool('recording_snapshot', { maxSize: 800 })
    expect(requests[0]).toMatchObject({ slides: [1], width: 800 })
    expect(reply).toContain('"type":"image"')
    expect(reply).toContain('第 2 页')

    const stale = await tool('recording_snapshot', { document: deckId, revision: 'old' })
    expect(stale).toContain('REVISION_UNAVAILABLE')
  })
})

describe('环境类错误带前缀和下一步', () => {
  it('没出稿就改字:前缀在开头,不被「没改:」盖住', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await call('deck.open', { path: dir })
    await mcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    await mcp('tools/call', { name: 'open_deck', arguments: { path: dir } })
    const reply = await mcp('tools/call', {
      name: 'edit_text',
      arguments: { slide: 0, old_text: '一', new_text: '二' },
    })
    expect(reply).toContain('"text":"NO_BUILD:')
    expect(reply).toContain('下一步')
  })
})

describe('doctor', () => {
  it('报版本、skill 在哪、界面连没连上、开着哪些稿子', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    const opened = await call('deck.open', { path: dir })
    const report = (await call('app.doctor', {})).data
    expect(report.app.version).toMatch(/\d/)
    expect(report.server.mcp).toContain('/mcp')
    expect(['explicit', 'bundled', 'local', 'missing']).toContain(report.skill.source)
    expect(report.skill.searched.length).toBeGreaterThan(0)
    // 测试里连着一个 WebSocket,就是「界面」
    expect(report.ui.connected).toBe(true)
    expect(report.decks.map((d: any) => d.id)).toContain(opened.data.deck.id)
  })

  it('握手时报的版本号就是 doctor 报的 app 版本', async () => {
    const init = await mcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    const { version } = (await call('app.doctor', {})).data.app
    expect(init).toContain(`"version":"${version}"`)
  })
})
