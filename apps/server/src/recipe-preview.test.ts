import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { dropOldPreviews } from './recipe-preview.js'

it('旧版本录的样片缓存整个清掉', async () => {
  const cache = join(await mkdtemp(join(tmpdir(), 'old-previews-')), 'recipe-previews')
  await mkdir(join(cache, 'ring-timeline'), { recursive: true })
  await writeFile(join(cache, 'ring-timeline/abc.webm'), 'x')
  await dropOldPreviews({ ORCA_PPT_PREVIEW_DIR: cache })
  await expect(stat(cache)).rejects.toThrow()
  // 已经没有了也不报错
  await dropOldPreviews({ ORCA_PPT_PREVIEW_DIR: cache })
})
