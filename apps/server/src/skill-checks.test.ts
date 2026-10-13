import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * skill 自带的检查，跟着 `pnpm test` 一起跑。前两个是静态检查，跟着 `pnpm test` 一起跑：
 * 主题文件守 themes.md「新建主题」的规矩，配色过对比度检查。
 * 以前它们只写在文档里（「新建配色必须跑 check-palettes」），没人跑就等于没有。
 */
const skill = fileURLToPath(new URL('../../../skills/orca-ppt/', import.meta.url))
const run = (script: string, args: string[] = []) =>
  spawnSync(process.execPath, [`scripts/${script}`, ...args], { cwd: skill, encoding: 'utf8' })

describe('skill 静态检查', () => {
  it('主题文件守规矩(check-themes)', () => {
    const result = run('check-themes.mjs')
    expect(result.status, result.stdout).toBe(0)
  })

  it('配色对比度过关(check-palettes)', () => {
    const result = run('check-palettes.mjs')
    expect(result.status, result.stdout).toBe(0)
  })

  /*
   * 例子是 agent 学写法的主载体：示例和同款样稿里有一条违规，agent 学到的就是违规。
   * 所以所有示例和样稿必须 0 错误。规则改了，这里会告诉你哪些例子跟着要改。
   * check-deck 要开本机 Chrome 量真实布局；没装 Chrome 的机器上跳过，不算失败。
   */
  it('示例和同款样稿 0 错误(check-deck)', (context) => {
    const decks = ['examples', 'recipes'].flatMap((dir) =>
      readdirSync(join(skill, dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
        .map((entry) => `${dir}/${entry.name}/index.html`)
        .filter((file) => existsSync(join(skill, file))),
    )
    const result = run('check-deck.mjs', decks)
    if (result.status !== 0 && /chrome|Executable|browserType\.launch/i.test(result.stderr)) {
      context.skip()
    }
    expect(result.status, result.stdout + result.stderr).toBe(0)
  }, 180_000)
})
