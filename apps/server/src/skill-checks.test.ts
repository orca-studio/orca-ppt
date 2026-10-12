import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * skill 自带的两个静态检查，跟着 `pnpm test` 一起跑：
 * 主题文件守 themes.md「新建主题」的规矩，配色过对比度检查。
 * 以前它们只写在文档里（「新建配色必须跑 check-palettes」），没人跑就等于没有。
 */
const skill = fileURLToPath(new URL('../../../skills/orca-ppt/', import.meta.url))
const run = (script: string) =>
  spawnSync(process.execPath, [`scripts/${script}`], { cwd: skill, encoding: 'utf8' })

describe('skill 静态检查', () => {
  it('主题文件守规矩(check-themes)', () => {
    const result = run('check-themes.mjs')
    expect(result.status, result.stdout).toBe(0)
  })

  it('配色对比度过关(check-palettes)', () => {
    const result = run('check-palettes.mjs')
    expect(result.status, result.stdout).toBe(0)
  })
})
