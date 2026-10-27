import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer, type OrcaServer } from '../../server/src/server.js'
import { callTool, listTools } from './mcp.js'

/** CLI 的 tools / call 连的是真的 `/mcp`:不另写工具,说明和行为都和 MCP 那一份一样。 */
let server: OrcaServer
beforeEach(async () => {
  server = await startServer({
    recordingFile: join(await mkdtemp(join(tmpdir(), 'recording-')), 'recording.jsonl'),
  })
})
afterEach(async () => {
  await server.close()
})

describe('orca-ppt tools / call', () => {
  it('列出的工具和 MCP 的是同一份,带使用说明和参数', async () => {
    const { instructions, tools } = await listTools(server.port)
    expect(instructions).toContain('take_control')
    const show = tools.find((tool) => tool.name === 'show_slide')
    expect(show?.params).toContainEqual(
      expect.objectContaining({ name: 'index', type: 'integer', required: true }),
    )
  })

  it('调工具拿到文字结果;工具自己拒绝时 isError,原因照原文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await writeFile(
      join(dir, 'deck.html'),
      '<div class="slides"><section><p>一</p></section></div>',
    )
    expect((await callTool(server.port, 'open_deck', { path: dir })).isError).toBe(false)

    const status = await callTool(server.port, 'deck_status', {})
    expect(JSON.parse(status.text[0]!).slideCount).toBe(1)

    const refused = await callTool(server.port, 'edit_text', {
      slide: 0,
      old_text: '没有这段字',
      new_text: 'x',
    })
    expect(refused.isError).toBe(true)
    expect(refused.text.join()).toContain('找不到')
  })

  it('server 没开时说清楚先开什么', async () => {
    await expect(listTools(1)).rejects.toThrow('orca-ppt serve --detach')
  })
})
