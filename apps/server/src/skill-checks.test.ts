import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { listRecipes, readPageTypes, recipeEntry, sliceSections } from '@orca-ppt/deck-core'
import { checkDeck, readSpec } from '@orca-ppt/deck-agent'

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

  /*
   * 应用里的出稿检查(spec-check)和 check-deck 是两份实现,走样过:环形时间轴的扇形
   * 故意出血,check-deck 认得,应用里却报了 21 条越界,agent 只能自己判断是误报。
   * 同款样稿在两边都必须 0 条。
   */
  it('同款样稿在应用的出稿检查里也是 0 条(spec-check)', async () => {
    const spec = await readSpec(skill)
    const found: string[] = []
    for (const recipe of await listRecipes(skill)) {
      const sample = await recipeEntry(skill, recipe.id)
      if (!sample) continue
      const html = await readFile(sample.entry, 'utf8')
      for (const issue of checkDeck(html, sliceSections(html), readPageTypes(html), spec)) {
        found.push(`${recipe.id} 第 ${issue.slide + 1} 页:${issue.message}`)
      }
    }
    expect(found).toEqual([])
  })
})
