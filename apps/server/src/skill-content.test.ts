import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { listSkill, readSkill } from './skill-content.js'

it('分页读取随附规范，保留 Unicode 并提供引用目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-content-'))
  await writeFile(join(root, 'SKILL.md'), '😀'.repeat(6001))
  await mkdir(join(root, 'references'))
  const first = await readSkill(root)
  expect(Array.from(first.text)).toHaveLength(6000)
  expect(first.next).toBe(6000)
  expect((await readSkill(root, 'SKILL.md', first.next!)).text).toBe('😀')
  expect((await listSkill(root)).entries).toContainEqual({ name: 'references', directory: true })
})

it('拒绝父目录、绝对路径、越界软链和非文本文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-boundary-'))
  await writeFile(join(root, 'image.png'), 'image')
  await symlink(tmpdir(), join(root, 'outside'))
  await expect(readSkill(root, '../secret.md')).rejects.toThrow('SKILL_PATH_DENIED')
  await expect(readSkill(root, '/etc/passwd')).rejects.toThrow('SKILL_PATH_DENIED')
  await expect(listSkill(root, 'outside')).rejects.toThrow('SKILL_PATH_DENIED')
  await expect(readSkill(root, 'image.png')).rejects.toThrow('SKILL_FILE_UNSUPPORTED')
  await expect(readSkill(undefined)).rejects.toThrow('SKILL_NOT_FOUND')
})
