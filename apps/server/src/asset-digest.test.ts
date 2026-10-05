import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fileDigest } from './asset-digest.js'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) }
})

describe('asset revision memory', () => {
  it('streams a large asset once for simultaneous readers and preserves the content digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-digest-'))
    try {
      const path = join(dir, 'video.bin')
      const data = Buffer.alloc(8 * 1024 * 1024, 37)
      await writeFile(path, data)
      const expected = createHash('sha256').update(data).digest('hex')
      vi.mocked(createReadStream).mockClear()
      const results = await Promise.all(Array.from({ length: 24 }, () => fileDigest(path)))
      expect(results.every((digest) => digest === expected)).toBe(true)
      expect(createReadStream).toHaveBeenCalledTimes(1)
      expect(await fileDigest(path)).toBe(expected)
      expect(createReadStream).toHaveBeenCalledTimes(1)
      await writeFile(path, 'new asset')
      expect(await fileDigest(path)).toBe(createHash('sha256').update('new asset').digest('hex'))
      expect(createReadStream).toHaveBeenCalledTimes(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('missing assets do not poison a later successful read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-digest-'))
    try {
      const path = join(dir, 'later.bin')
      expect(await fileDigest(path)).toBe('')
      await writeFile(path, 'ready')
      expect(await fileDigest(path)).toBe(createHash('sha256').update('ready').digest('hex'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
