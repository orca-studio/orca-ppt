import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

const cache = new Map<string, { version: string; digest: string }>()
const pending = new Map<string, Promise<string>>()
const CACHE_LIMIT = 512

/** Stream large assets and share simultaneous revision reads of the same file version. */
export async function fileDigest(path: string): Promise<string> {
  try {
    const info = await stat(path)
    const version = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`
    const cached = cache.get(path)
    if (cached?.version === version) {
      cache.delete(path)
      cache.set(path, cached)
      return cached.digest
    }
    const key = `${path}\0${version}`
    const existing = pending.get(key)
    if (existing) return await existing
    const reading = (async () => {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      const digest = hash.digest('hex')
      cache.delete(path)
      cache.set(path, { version, digest })
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      return digest
    })()
    pending.set(key, reading)
    try {
      return await reading
    } finally {
      pending.delete(key)
    }
  } catch {
    return ''
  }
}
