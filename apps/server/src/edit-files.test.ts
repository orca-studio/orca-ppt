import { mkdtemp, mkdir, readFile, symlink, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readEditFile, writeEditFiles } from './edit-files.js'

it('checks every file before committing and cleans staged files on conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-edit-files-'))
  await mkdir(join(root, '.deck'))
  await writeFile(join(root, 'deck.html'), 'before')
  await writeFile(join(root, '.deck/plan.json'), 'external')
  await expect(
    writeEditFiles(root, {
      'deck.html': { before: 'before', after: 'after' },
      '.deck/plan.json': { before: 'expected', after: 'new' },
    }),
  ).rejects.toThrow('STALE_REVISION')
  expect(await readFile(join(root, 'deck.html'), 'utf8')).toBe('before')
  expect(await readdir(root)).toEqual(['.deck', 'deck.html'])
})

it('refuses entry and metadata directory symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-edit-files-'))
  const outside = await mkdtemp(join(tmpdir(), 'orca-edit-outside-'))
  await writeFile(join(outside, 'deck.html'), 'untouched')
  await symlink(join(outside, 'deck.html'), join(root, 'deck.html'))
  await symlink(outside, join(root, '.deck'))
  await expect(readEditFile(root, 'deck.html')).rejects.toThrow('符号链接')
  await expect(readEditFile(root, '.deck/outline.json')).rejects.toThrow('符号链接')
  expect(await readFile(join(outside, 'deck.html'), 'utf8')).toBe('untouched')
})
