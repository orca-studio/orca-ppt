import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { expandHome } from './create.js'

it('~ 开头的路径展开成家目录,别的原样', () => {
  expect(expandHome('~/Documents/Orca PPT/x')).toBe(join(homedir(), 'Documents/Orca PPT/x'))
  expect(expandHome('~')).toBe(homedir())
  expect(expandHome('/abs/path')).toBe('/abs/path')
  expect(expandHome('~other/x')).toBe('~other/x')
})
