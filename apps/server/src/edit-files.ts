import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type FileChanges = Record<string, { before: string | null; after: string | null }>
const names = new Set([
  'deck.html',
  'index.html',
  '.deck/brief.json',
  '.deck/outline.json',
  '.deck/plan.json',
])
export async function readEditFile(root: string, name: string): Promise<string | null> {
  if (!names.has(name)) throw new Error('不支持的编辑文件')
  // Refuse symlinks, including metadata directory, rather than writing outside the deck.
  for (const path of name.startsWith('.deck/')
    ? [join(root, '.deck'), join(root, name)]
    : [join(root, name)]) {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('不支持编辑符号链接')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  return readFile(join(root, name), 'utf8')
}

/** Stage first, recheck all inputs, then rename. Roll back completed writes on failure. */
export async function writeEditFiles(root: string, changes: FileChanges): Promise<void> {
  const staged = new Map<string, string>()
  const completed: string[] = []
  try {
    for (const [name, change] of Object.entries(changes)) {
      if ((await readEditFile(root, name)) !== change.before)
        throw new Error('STALE_REVISION: 文件已变化')
      if (change.after !== null) {
        const temp = join(root, `${name}.${randomUUID()}.tmp`)
        staged.set(name, temp)
        await writeFile(temp, change.after, { encoding: 'utf8', flag: 'wx' })
      }
    }
    for (const [name, change] of Object.entries(changes)) {
      if ((await readEditFile(root, name)) !== change.before)
        throw new Error('STALE_REVISION: 文件已变化')
    }
    for (const [name, change] of Object.entries(changes)) {
      if (change.before === change.after) continue
      // A second check narrows the window for external editor writes.
      if ((await readEditFile(root, name)) !== change.before)
        throw new Error('STALE_REVISION: 文件已变化')
      if (change.after === null) await rm(join(root, name), { force: true })
      else await rename(staged.get(name)!, join(root, name))
      completed.push(name)
    }
  } catch (error) {
    for (const name of completed.reverse()) {
      const change = changes[name]!
      if ((await readEditFile(root, name)) !== change.after) continue
      if (change.before === null) await rm(join(root, name), { force: true })
      else await writeFile(join(root, name), change.before, 'utf8')
    }
    throw error
  } finally {
    for (const temp of staged.values()) await rm(temp, { force: true })
  }
}
