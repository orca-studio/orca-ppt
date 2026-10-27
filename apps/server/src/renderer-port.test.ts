import { describe, expect, it } from 'vitest'
import { noRenderer, parentPortRenderer } from './renderer-port.js'

/** 扮演主进程那一头的 parentPort:记下发出去的请求,由用例决定怎么回。 */
function fakePort() {
  const sent: any[] = []
  let listener: ((event: { data: unknown }) => void) | undefined
  return {
    sent,
    reply: (data: unknown) => listener?.({ data }),
    port: {
      on: (_event: 'message', next: (event: { data: unknown }) => void) => {
        listener = next
      },
      postMessage: (message: unknown) => sent.push(message),
    },
  }
}

describe('parentPortRenderer', () => {
  it('不在 utilityProcess 里就没有渲染器', () => {
    expect(parentPortRenderer(undefined)).toBeUndefined()
  })

  it('请求带 id 发给主进程,按 id 认回复', async () => {
    const fake = fakePort()
    const renderer = parentPortRenderer(fake.port)!
    const job = { previewUrl: 'http://127.0.0.1/p/x/deck.html', slideCount: 2 }
    const pending = renderer.thumbnails(job)
    expect(fake.sent[0]).toMatchObject({ method: 'thumbnails', job })
    // 别人的回复不算
    fake.reply({ id: 'other', value: ['/nope.png'] })
    fake.reply({ id: fake.sent[0].id, value: ['/a.png', null] })
    await expect(pending).resolves.toEqual(['/a.png', null])
  })

  it('主进程渲失败,原因原样带回来', async () => {
    const fake = fakePort()
    const renderer = parentPortRenderer(fake.port)!
    const pending = renderer.exportPptx({ previewUrl: 'u', outPath: '/tmp/pptx-exports/a.pptx' })
    fake.reply({ id: fake.sent[0].id, error: '稿子没有录制接口' })
    await expect(pending).rejects.toThrow('稿子没有录制接口')
  })
})

describe('noRenderer', () => {
  it('一律说 NO_RENDERER,不假装成功', async () => {
    await expect(noRenderer.thumbnails({ previewUrl: 'u', slideCount: 1 })).rejects.toThrow(
      /^NO_RENDERER:/,
    )
    await expect(noRenderer.exportPptx({ previewUrl: 'u', outPath: 'o' })).rejects.toThrow(
      /^NO_RENDERER:/,
    )
  })
})
