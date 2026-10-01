import { describe, expect, it, vi } from 'vitest'
import { Roundtrip } from './roundtrip.js'

describe('Roundtrip', () => {
  it('把请求推给壳,壳回话后给出路径', async () => {
    const announce = vi.fn()
    const broker = new Roundtrip<string, { slide?: number }>(announce)
    const pending = broker.request('/d', { slide: 2 })

    expect(announce.mock.calls[0]![0]).toMatchObject({ deckId: '/d', slide: 2 })
    broker.settle(announce.mock.calls[0]![0].requestId, { value: '/tmp/a.png' })
    expect(await pending).toBe('/tmp/a.png')
  })

  it('不给页号就是截当前这一页', () => {
    const announce = vi.fn()
    const broker = new Roundtrip<string, { slide?: number }>(announce)
    void broker.request('/d').catch(() => {})
    expect(announce.mock.calls[0]![0]).not.toHaveProperty('slide')
  })

  it('壳报错就如实失败', async () => {
    const announce = vi.fn()
    const broker = new Roundtrip<string, { slide?: number }>(announce)
    const pending = broker.request('/d')
    broker.settle(announce.mock.calls[0]![0].requestId, { error: '画布还没加载' })
    await expect(pending).rejects.toThrow('画布还没加载')
  })

  it('壳不回话就超时,不把调用方吊死', async () => {
    const broker = new Roundtrip<string>(vi.fn(), 20)
    await expect(broker.request('/d')).rejects.toThrow(/^UI_TIMEOUT:/)
  })

  it('超时之后才回来的结果被忽略,不炸', async () => {
    const announce = vi.fn()
    const broker = new Roundtrip<string>(announce, 20)
    await expect(broker.request('/d')).rejects.toThrow()
    expect(broker.settle(announce.mock.calls[0]![0].requestId, { value: '/x.png' })).toBe(false)
  })

  it('没人看着了就一起失败', async () => {
    const broker = new Roundtrip<string>(vi.fn())
    const pending = broker.request('/d')
    broker.failAll('界面断开了')
    await expect(pending).rejects.toThrow('界面断开了')
  })
})
