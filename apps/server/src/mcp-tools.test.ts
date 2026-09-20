import { describe, expect, it, vi } from 'vitest'
import { ActiveDeck, buildTools, type ProtocolCaller } from './mcp-tools.js'

function fakeClient(responses: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = []
  const client = vi.fn(async (method: string, params: unknown) => {
    calls.push([method, params])
    return responses[method] ?? {}
  }) as unknown as ProtocolCaller
  return { client, calls }
}

function toolsOf(client: ProtocolCaller, active = new ActiveDeck()) {
  const map = new Map(buildTools(client, active).map((tool) => [tool.name, tool]))
  return { map, active }
}

const anchorRequest = {
  id: 'r1',
  kind: 'anchor' as const,
  createdAt: 0,
  anchor: {
    kind: 'element' as const,
    slide: 3,
    selector: 'h2',
    box: { x: 180, y: 220, w: 1560, h: 120 },
    text: '增长的三个来源',
    crop: '/data/anchors/a.png',
    note: '这儿太挤',
  },
}

describe('MCP 工具', () => {
  it('应用里开着一份就直接用它 —— 不逼 agent 再开一次,它多半会猜错路径', async () => {
    const { client, calls } = fakeClient({
      'deck.list': { decks: [{ id: '/already-open', path: '/already-open' }] },
      'phase.check': { phases: [] },
    })
    const { map } = toolsOf(client)
    await map.get('deck_status')!.run({})
    expect(calls[1]).toEqual(['phase.check', { deckId: '/already-open' }])
  })

  it('应用里一份都没开就如实说,而不是拿个空 id 去问 server', async () => {
    const { client } = fakeClient({ 'deck.list': { decks: [] } })
    const { map } = toolsOf(client)
    await expect(map.get('deck_status')!.run({})).rejects.toThrow('还没打开 deck')
  })

  it('开着好几份时要求指定,并把路径都列出来', async () => {
    const { client } = fakeClient({
      'deck.list': {
        decks: [
          { id: '/a', path: '/a' },
          { id: '/b', path: '/b' },
        ],
      },
    })
    const { map } = toolsOf(client)
    await expect(map.get('deck_status')!.run({})).rejects.toThrow('/a、/b')
  })

  it('open_deck 记住当前 deck,后面的工具不用再传路径', async () => {
    const { client, calls } = fakeClient({
      'deck.open': { deck: { id: '/d' }, slideCount: 4, phases: [], previewUrl: 'http://x' },
      'phase.check': { phases: [] },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    await map.get('deck_status')!.run({})
    expect(calls[1]).toEqual(['phase.check', { deckId: '/d' }])
  })

  it('show_slide 的回话按人读的页号,从 1 数起', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    const result = await map.get('show_slide')!.run({ index: 3 })
    expect(result.content[0]!.text).toContain('第 4 页')
  })

  it('take_requests 把锚翻译成模型一眼看懂的样子', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
      'requests.take': { requests: [anchorRequest] },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    const out = (await map.get('take_requests')!.run({})).content[0]!.text

    expect(out).toContain('第 4 页')
    expect(out).toContain('(180, 220)')
    expect(out).toContain('1560×120')
    expect(out).toContain('这儿太挤')
    expect(out).toContain('/data/anchors/a.png')
  })

  it('队列空时说清楚是空的,不返回一个空数组让模型猜', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
      'requests.take': { requests: [] },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    expect((await map.get('take_requests')!.run({})).content[0]!.text).toContain('队列是空的')
  })

  it('转场锚说的是两页之间', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
      'requests.take': {
        requests: [
          {
            id: 'r2',
            kind: 'anchor',
            createdAt: 0,
            anchor: { kind: 'transition', from: 2, to: 3, note: '这个硬切没对上' },
          },
        ],
      },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    const out = (await map.get('take_requests')!.run({})).content[0]!.text
    expect(out).toContain('第 3 页 → 第 4 页')
  })

  it('被上游挡住时,phase_prompt 给的是拒绝理由而不是提示词', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
      'phase.prompt': { blockedBy: 'outline', issues: ['第 1 页:格子凑不满'] },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    const out = (await map.get('phase_prompt')!.run({ phase: 'plan' })).content[0]!.text
    expect(out).toContain('卡在「outline」')
    expect(out).toContain('格子凑不满')
  })

  it('闸门放行时给出提示词本身', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
      'phase.prompt': { prompt: '写进 .deck/brief.json', issues: [] },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    const out = (await map.get('phase_prompt')!.run({ phase: 'brief', request: '讲讲 Q3' }))
      .content[0]!.text
    expect(out).toContain('.deck/brief.json')
  })

  it('每个工具都有中文标题和说明 —— 模型靠它决定什么时候调', () => {
    const { client } = fakeClient()
    for (const tool of buildTools(client, new ActiveDeck())) {
      expect(tool.config.title.length).toBeGreaterThan(0)
      expect(tool.config.description.length).toBeGreaterThan(20)
    }
  })
})
