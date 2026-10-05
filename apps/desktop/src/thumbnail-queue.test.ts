import { describe, expect, it } from 'vitest'
import { ThumbnailQueue } from './thumbnail-queue.js'

const gate = () => {
  let release!: (paths: Array<string | null>) => void
  const promise = new Promise<Array<string | null>>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('thumbnail rendering resource limits', () => {
  it('rapid refreshes keep one active window and only the latest waiting render', async () => {
    const queue = new ThumbnailQueue()
    const active = gate()
    const started: number[] = []
    const first = queue.run('deck', () => {
      started.push(0)
      return active.promise
    })
    const refreshes = Array.from({ length: 32 }, (_, i) =>
      queue.run('deck', async () => {
        started.push(i + 1)
        return [`${i + 1}.png`]
      }),
    )
    expect(started).toEqual([0])
    active.release(['0.png'])
    expect(await first).toEqual(['0.png'])
    const results = await Promise.all(refreshes)
    expect(started).toEqual([0, 32])
    expect(results.slice(0, -1).every((paths) => paths.length === 0)).toBe(true)
    expect(results.at(-1)).toEqual(['32.png'])
  })

  it('bounds waiting requests across distinct capture targets', async () => {
    const queue = new ThumbnailQueue(2)
    const active = gate()
    const first = queue.run('active', () => active.promise)
    const second = queue.run('slide-1', async () => ['1.png'])
    const third = queue.run('slide-2', async () => ['2.png'])
    await expect(queue.run('slide-3', async () => ['3.png'])).rejects.toThrow('繁忙')
    active.release([])
    await Promise.all([first, second, third])
  })

  it('a failed render releases the slot for the next target', async () => {
    const queue = new ThumbnailQueue()
    const failed = queue.run('broken', async () => {
      throw new Error('window closed')
    })
    const next = queue.run('next', async () => ['next.png'])
    await expect(failed).rejects.toThrow('window closed')
    await expect(next).resolves.toEqual(['next.png'])
  })
})
