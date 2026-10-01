import { open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

async function within(root: string | undefined, path: string): Promise<string> {
  if (!root) throw new Error('SKILL_NOT_FOUND: 应用未找到随附规范。')
  if (isAbsolute(path) || path.split(/[\\/]/).some((p) => p === '..' || p.startsWith('.')))
    throw new Error('SKILL_PATH_DENIED: 只允许规范内的相对路径。')
  const base = await realpath(root)
  const file = await realpath(resolve(base, path || '.'))
  const rel = relative(base, file)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error('SKILL_PATH_DENIED: 路径越界。')
  return file
}

export async function listSkill(root: string | undefined, path = '', offset = 0) {
  const dir = await within(root, path)
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith('.') && !e.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    path,
    entries: entries
      .slice(offset, offset + 100)
      .map((e) => ({ name: e.name, directory: e.isDirectory() })),
    next: offset + 100 < entries.length ? offset + 100 : null,
  }
}

export async function readSkill(root: string | undefined, path = 'SKILL.md', offset = 0) {
  const file = await within(root, path)
  const info = await stat(file)
  if (!info.isFile() || info.size > 2 * 1024 * 1024)
    throw new Error('SKILL_FILE_UNSUPPORTED: 只读取不超过 2 MB 的规范文本。')
  if (
    !['.md', '.txt', '.json', '.html', '.css', '.js', '.mjs', '.ts', '.yml', '.yaml'].includes(
      extname(file).toLowerCase(),
    )
  )
    throw new Error('SKILL_FILE_UNSUPPORTED: 此接口仅提供文本资料。')
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 2 * 1024 * 1024) throw new Error('SKILL_FILE_UNSUPPORTED: 文件过大。')
    const chars = Array.from(buffer.subarray(0, bytesRead).toString('utf8'))
    const end = Math.min(offset + 6000, chars.length)
    return {
      path,
      text: chars.slice(offset, end).join(''),
      next: end < chars.length ? end : null,
      total: chars.length,
    }
  } finally {
    await handle.close()
  }
}
