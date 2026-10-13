import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ActiveDeck, buildTools, type ProtocolCaller } from './mcp-tools.js'

function fakeClient(responses: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = []
  const client = vi.fn(async (method: string, params: unknown) => {
    calls.push([method, params])
    return responses[method] ?? {}
  }) as unknown as ProtocolCaller
  return { client, calls }
}

/** 结果里的第一段文字。图片不算。 */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === 'text')?.text ?? ''
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
      'deck.inspect': { revision: 'r', slides: [] },
      'phase.check': { phases: [] },
    })
    const { map } = toolsOf(client)
    await map.get('deck_status')!.run({})
    expect(calls).toContainEqual(['deck.inspect', { deckId: '/already-open' }])
    expect(calls).toContainEqual(['phase.check', { deckId: '/already-open' }])
  })

  it('应用里一份都没开就如实说,而不是拿个空 id 去问 server', async () => {
    const { client } = fakeClient({ 'deck.list': { decks: [] } })
    const { map } = toolsOf(client)
    await expect(map.get('deck_status')!.run({})).rejects.toThrow(/^NO_DECK_OPEN:.*下一步/)
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
      'deck.inspect': { revision: 'r', slides: [] },
      'phase.check': { phases: [] },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    await map.get('deck_status')!.run({})
    expect(calls).toContainEqual(['deck.inspect', { deckId: '/d' }])
  })

  it('show_slide 的回话按人读的页号,从 1 数起', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    const result = await map.get('show_slide')!.run({ index: 3 })
    expect(textOf(result)).toContain('第 4 页')
  })

  it('user_selection 把锚翻译成模型一眼看懂的样子', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
      'requests.take': { requests: [anchorRequest] },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    const out = textOf(await map.get('user_selection')!.run({}))

    expect(out).toContain('第 4 页')
    expect(out).toContain('(180, 220)')
    expect(out).toContain('1560×120')
    expect(out).toContain('这儿太挤')
    expect(out).toContain('/data/anchors/a.png')
  })

  it('没指着任何地方时说清楚,不返回一个空数组让模型猜', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
      'requests.take': { requests: [] },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    expect(textOf(await map.get('user_selection')!.run({}))).toContain('没指着任何地方')
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
    const out = textOf(await map.get('user_selection')!.run({}))
    expect(out).toContain('第 3 页 → 第 4 页')
  })

  it('被上游挡住时,phase_prompt 给的是拒绝理由而不是提示词', async () => {
    const { client } = fakeClient({
      'deck.open': { deck: { id: '/d' }, phases: [], previewUrl: '' },
      'phase.prompt': { blockedBy: 'outline', issues: ['第 1 页:格子凑不满'] },
    })
    const { map } = toolsOf(client)
    await map.get('open_deck')!.run({ path: '/d' })
    const out = textOf(await map.get('phase_prompt')!.run({ phase: 'plan' }))
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
    const out = textOf(await map.get('phase_prompt')!.run({ phase: 'brief', request: '讲讲 Q3' }))
    expect(out).toContain('.deck/brief.json')
  })

  it('每个工具都有中文标题和说明 —— 模型靠它决定什么时候调', () => {
    const { client } = fakeClient()
    for (const tool of buildTools(client, new ActiveDeck())) {
      expect(tool.config.title.length).toBeGreaterThan(0)
      expect(tool.config.description.length).toBeGreaterThan(20)
    }
  })

  it('deck_status 给出版本号和每页原文,页号两套都给', async () => {
    const { client } = fakeClient({
      'deck.list': { decks: [{ id: '/d', path: '/d' }] },
      'deck.inspect': {
        revision: 'abc123',
        slides: [{ index: 0, title: '封面', pageType: 'cover', texts: ['Studio placeholder'] }],
      },
      'phase.check': { phases: [{ phase: 'build', ok: true, issues: [] }] },
    })
    const { map } = toolsOf(client)
    const out = JSON.parse(textOf(await map.get('deck_status')!.run({})))
    expect(out.revision).toBe('abc123')
    expect(out.slideCount).toBe(1)
    expect(out.slides[0]).toEqual({
      slide: 0,
      page: 1,
      title: '封面',
      pageType: 'cover',
      texts: ['Studio placeholder'],
    })
    expect(out.phases).toHaveLength(1)
  })

  it('capture_slide 把图直接附在结果里,另给路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-capture-'))
    const file = join(dir, 'shot.png')
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const { client } = fakeClient({
      'deck.list': { decks: [{ id: '/d', path: '/d' }] },
      'deck.capture': { path: file },
    })
    const { map } = toolsOf(client)
    const result = await map.get('capture_slide')!.run({})
    expect(textOf(result)).toContain(file)
    expect(result.content).toContainEqual({
      type: 'image',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png',
    })
  })

  it('图读不到时退回只给路径 —— 截图本身是成功的', async () => {
    const { client } = fakeClient({
      'deck.list': { decks: [{ id: '/d', path: '/d' }] },
      'deck.capture': { path: '/nowhere/shot.png' },
    })
    const { map } = toolsOf(client)
    const result = await map.get('capture_slide')!.run({})
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(textOf(result)).toContain('/nowhere/shot.png')
  })

  it('每个工具都标了会不会动稿子 —— 宿主靠它决定要不要先问人', () => {
    const { client } = fakeClient()
    const byName = new Map(
      buildTools(client, new ActiveDeck()).map((tool) => [tool.name, tool.config.annotations]),
    )
    for (const [, annotations] of byName) {
      expect(annotations.openWorldHint).toBe(false)
    }
    // 动磁盘的,和取走就清空的,不能标成只读。
    for (const name of ['edit_text', 'create_deck', 'open_deck', 'user_selection']) {
      expect(byName.get(name)?.readOnlyHint).toBe(false)
    }
    for (const name of ['deck_status', 'capture_slide', 'peek_selection', 'check_phase']) {
      expect(byName.get(name)?.readOnlyHint).toBe(true)
    }
  })

  it('undo 没撤成时如实报错,撤成了说清是哪一页、现在是什么字', async () => {
    const { client } = fakeClient({
      'deck.list': { decks: [{ id: '/d', path: '/d' }] },
      'deck.undo': { ok: false, reason: '没有可以撤销的改动' },
      'deck.redo': { ok: true, slide: 2, text: '新标题' },
    })
    const { map } = toolsOf(client)
    const refused = await map.get('undo')!.run({})
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('没有可以撤销的改动')
    expect(textOf(await map.get('redo')!.run({}))).toContain('第 3 页')
  })

  it('undo / redo 标成会改稿子但不丢东西 —— 宿主据此知道这个应用撤得回去', () => {
    const { client } = fakeClient()
    const tools = new Map(buildTools(client, new ActiveDeck()).map((t) => [t.name, t.config]))
    for (const name of ['undo', 'redo']) {
      expect(tools.get(name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      })
    }
  })
})

it('UI 切换稿子后拒绝沿用旧任务目标，不静默改另一份', async () => {
  const responses = { 'deck.current': { deckId: '/a' } }
  const { client } = fakeClient(responses)
  const active = new ActiveDeck()
  expect(await active.get(client)).toBe('/a')
  responses['deck.current'] = { deckId: '/b' }
  await expect(active.get(client)).rejects.toThrow('DOCUMENT_CHANGED:')
  active.set('/b')
  expect(await active.get(client)).toBe('/b')
})

it('MCP 列出首页同一份同款', async () => {
  const { client, calls } = fakeClient({
    'catalog.recipes': {
      recipes: [{ id: 'recap-credits', title: '回顾片尾', mode: '汇报稿', prompt: 'p' }],
    },
  })
  const { map } = toolsOf(client)
  expect(textOf(await map.get('list_recipes')!.run({}))).toContain('recap-credits')
  expect(calls).toContainEqual(['catalog.recipes', {}])
  await map.get('present_recipe')!.run({ id: 'recap-credits' })
  expect(calls).toContainEqual(['recipe.present', { id: 'recap-credits' }])
})

it('MCP 放映同款样稿后，接下来的工具对准样稿，不报 DOCUMENT_CHANGED', async () => {
  const responses: Record<string, unknown> = {
    'deck.current': { deckId: '/mine' },
    'recipe.present': { deckId: '/sample' },
  }
  const { client, calls } = fakeClient(responses)
  const { map } = toolsOf(client)
  await map.get('present')!.run({}) // 先认下 /mine
  responses['deck.current'] = { deckId: '/sample' }
  await map.get('present_recipe')!.run({ id: 'ring-timeline' })
  await map.get('present')!.run({})
  expect(calls.filter(([method]) => method === 'deck.present').at(-1)?.[1]).toMatchObject({
    deckId: '/sample',
  })
})

it('MCP 翻页后直接报回画布停在哪一页', async () => {
  const { client } = fakeClient({
    'deck.current': { deckId: '/d' },
    'canvas.inspect': { slide: 3 },
  })
  const { map } = toolsOf(client)
  expect(textOf(await map.get('navigate')!.run({ action: 'next' }))).toContain('第 4 页(slide=3)')
})

it('MCP 截别的页之后把画布翻回人原来看的那一页', async () => {
  const { client, calls } = fakeClient({
    'deck.current': { deckId: '/d' },
    'canvas.inspect': { slide: 2 },
    'deck.capture': { path: '/nope.png', deckId: '/d', slide: 6 },
  })
  const { map } = toolsOf(client)
  await map.get('capture_slide')!.run({ slide: 6 })
  const shows = calls.filter(([method]) => method === 'deck.showSlide').map(([, p]) => p)
  expect(shows).toEqual([
    { deckId: '/d', index: 6 },
    { deckId: '/d', index: 2 },
  ])
}, 10_000)

it('MCP 放映不给页号就从第一页，stop_present 走 deck.stopPresent', async () => {
  const { client, calls } = fakeClient({ 'deck.current': { deckId: '/d' } })
  const { map } = toolsOf(client)
  await map.get('present')!.run({})
  expect(calls).toContainEqual(['deck.present', { deckId: '/d' }])
  await map.get('stop_present')!.run({})
  expect(calls).toContainEqual(['deck.stopPresent', { deckId: '/d' }])
})

it('MCP 在首页指着同款:播样片、打开做同款,都走 recipe.focus', async () => {
  const { client, calls } = fakeClient()
  const { map } = toolsOf(client)
  await map.get('preview_recipe')!.run({ id: 'ring-timeline' })
  await map.get('preview_recipe')!.run({ id: 'ring-timeline', on: false })
  await map.get('show_recipe_prompt')!.run({ id: 'ring-timeline' })
  await map.get('show_recipe_prompt')!.run({ id: 'ring-timeline', open: false })
  expect(calls.filter(([method]) => method === 'recipe.focus').map(([, p]) => p)).toEqual([
    { id: 'ring-timeline', show: 'preview' },
    { id: 'ring-timeline', show: 'none' },
    { id: 'ring-timeline', show: 'prompt' },
    { id: 'ring-timeline', show: 'none' },
  ])
})

it('MCP 改转场计划走 deck.editPlan,对不上就拒绝', async () => {
  const responses: Record<string, unknown> = {
    'deck.current': { deckId: '/d' },
    'deck.editPlan': { ok: true },
  }
  const { client, calls } = fakeClient(responses)
  const { map } = toolsOf(client)
  expect(textOf(await map.get('edit_plan')!.run({ old_text: '北岸软件', new_text: '' }))).toContain(
    '改好了',
  )
  expect(calls).toContainEqual([
    'deck.editPlan',
    { deckId: '/d', oldText: '北岸软件', newText: '' },
  ])
  responses['deck.editPlan'] = { ok: false, reason: '转场计划注释里找不到那段文字' }
  const refused = await map.get('edit_plan')!.run({ old_text: 'x', new_text: 'y' })
  expect(textOf(refused)).toContain('找不到')
})

it('MCP 关掉稿子回首页', async () => {
  const { client, calls } = fakeClient({ 'deck.current': { deckId: '/d' } })
  const { map } = toolsOf(client)
  await map.get('close_deck')!.run({})
  expect(calls).toContainEqual(['deck.close', { deckId: '/d' }])
})

it('MCP 新建透传 UI 的模板和主题，并提供同一个模板目录', async () => {
  const { client, calls } = fakeClient({
    'catalog.templates': { templates: [{ id: 'blank', title: '空白', mode: 'report' }] },
  })
  const { map } = toolsOf(client)
  expect(textOf(await map.get('list_templates')!.run({}))).toContain('blank')
  await map
    .get('create_deck')!
    .run({ parentDir: '/tmp', title: 'Test', from: 'blank', theme: 'forest' })
  expect(calls).toContainEqual([
    'deck.create',
    { parentDir: '/tmp', title: 'Test', from: 'blank', theme: 'forest' },
  ])
})

it('MCP 新建不给保存位置时不编一个，交给 server 的默认目录', async () => {
  const { client, calls } = fakeClient({ 'deck.create': { path: '/x' } })
  const { map } = toolsOf(client)
  await map.get('create_deck')!.run({ title: 'Demo', from: 'recipe:ring-timeline' })
  expect(calls).toContainEqual(['deck.create', { title: 'Demo', from: 'recipe:ring-timeline' }])
})

it('MCP 从同款新建时，告诉 agent 改了标题', async () => {
  const { client } = fakeClient({ 'deck.create': { path: '/tmp/demo' } })
  const { map } = toolsOf(client)
  const result = textOf(
    await map
      .get('create_deck')!
      .run({ parentDir: '/tmp', title: 'Demo', from: 'recipe:ring-timeline' }),
  )
  expect(result).toContain('/tmp/demo')
  expect(result).toContain('<title> 改成了「Demo」')
})

it('publishes readable labels without changing the edit_text protocol', () => {
  const { client } = fakeClient()
  const tool = buildTools(client, new ActiveDeck()).find((tool) => tool.name === 'edit_text')!
  const input = z.object(tool.config.inputSchema!)
  const fields = z.toJSONSchema(input).properties!
  expect(fields.slide).toMatchObject({
    title: '页码',
    'x-jevbot-format': 'one-based-index',
  })
  expect(fields.old_text).toMatchObject({ title: '原文字' })
  expect(fields.new_text).toMatchObject({ title: '替换为' })
  expect(input.parse({ slide: 0, old_text: 'before', new_text: 'after' }).slide).toBe(0)
})

describe('canvas MCP surface', () => {
  it('uses the shared inspection protocol for each observation and preserves version guards', async () => {
    const { client, calls } = fakeClient({
      'deck.current': { deckId: '/d' },
      'canvas.inspect': { revision: 'r1', current: true },
    })
    const { map } = toolsOf(client)
    for (const [tool, include] of [
      ['get_canvas_context', 'context'],
      ['get_canvas_elements', 'elements'],
      ['get_canvas_html', 'html'],
      ['get_canvas_errors', 'errors'],
    ]) {
      await map.get(tool!)!.run({ expected_revision: 'r1' })
      expect(calls).toContainEqual([
        'canvas.inspect',
        { deckId: '/d', include, expectedRevision: 'r1' },
      ])
      expect(map.get(tool!)!.config.annotations.readOnlyHint).toBe(true)
    }
    expect(calls.some(([method]) => method === 'requests.take')).toBe(false)
  })
  it('selects and clears using the same revision-bound protocol', async () => {
    const { client, calls } = fakeClient({ 'deck.current': { deckId: '/d' } })
    const { map } = toolsOf(client)
    await map
      .get('select_canvas_element')!
      .run({ selector: '#title', slide: 2, expected_revision: 'r1' })
    await map
      .get('select_canvas_element')!
      .run({ selector: null, slide: 2, expected_revision: 'r1' })
    expect(calls).toContainEqual([
      'canvas.select',
      { deckId: '/d', selector: '#title', slide: 2, expectedRevision: 'r1' },
    ])
    expect(calls).toContainEqual([
      'canvas.select',
      { deckId: '/d', selector: null, slide: 2, expectedRevision: 'r1' },
    ])
  })
})

describe('shared page and image tools', () => {
  it('uses the shared protocol with revision and propagates stale refusal', async () => {
    const { client, calls } = fakeClient({
      'deck.list': { decks: [{ id: '/d', path: '/d' }] },
      'deck.editPages': { ok: true, revision: 'next', slide: 2 },
      'deck.replaceImage': { ok: false, reason: 'STALE_REVISION: changed' },
    })
    const { map } = toolsOf(client)
    expect(
      (
        await map
          .get('edit_pages')!
          .run({ action: 'move', index: 0, to: 2, expected_revision: 'before' })
      ).isError,
    ).toBeUndefined()
    expect(calls).toContainEqual([
      'deck.editPages',
      {
        deckId: '/d',
        expectedRevision: 'before',
        change: { action: 'move', index: 0, to: 2 },
      },
    ])
    const refused = await map.get('replace_image')!.run({
      slide: 2,
      selector: '#photo',
      old_source: 'a.png',
      source_path: 'assets/b.png',
      expected_revision: 'before',
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('STALE_REVISION')
    expect(
      (await map.get('edit_pages')!.run({ action: 'move', index: 0, expected_revision: 'before' }))
        .isError,
    ).toBe(true)
  })
})
