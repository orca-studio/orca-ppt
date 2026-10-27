#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DeckPhase, PptxExportReport } from '@orca-ppt/contracts'
import { readSpec } from '@orca-ppt/deck-agent'
import {
  createDeck,
  expandHome,
  findEntryName,
  listRecipes,
  listTemplates,
  phaseGate,
  pptxTargetProblem,
  readCatalog,
  readPhaseStatus,
  resolveSkillPath,
  summarizePptx,
} from '@orca-ppt/deck-core'
import { playwrightRenderer } from '@orca-ppt/render'

/**
 * `orca-ppt`:不开应用也能做稿子。agent 批量新建、按阶段写、检查、导出,人想看再开
 * `orca-ppt serve` 或桌面版 —— 它们看的是同一个目录,磁盘就是同步通道。
 *
 * 这是一个**库客户端**:直接调 deck-core / deck-agent / 渲染器,不经过 server。但这里能做的
 * 每一件事,协议里都有对应的方法(`deck.create`、`catalog.*`、`phase.*`、`deck.exportPptx`),
 * 不长出界面和 MCP 都没有的能力(见 docs/ARCHITECTURE.md「一个内核,三种形态」)。
 *
 * 规范、配方、自检脚本在 skill 里:`orca-ppt` 只做产品那一侧的事,写稿子照 skill 的 SKILL.md。
 */

const HELP = `用法:orca-ppt <命令> [参数]

  new <标题> [--from recipe:<id>|template:<文件>] [--theme <主题>] [--dir <父目录>]
                    新建一份稿子,打印它的目录。不给 --dir 就放在 ~/Documents/Orca PPT/
  recipes           同款列表(做同款时 --from recipe:<id>)
  templates         空白起始文件列表(--from 后面填 id)
  themes            主题列表(--theme 后面填名字)
  prompt <阶段> [--deck <目录>] [--request <用户那句话>]
                    取一个阶段的做法。上游产物不合规就拒绝,说清卡在哪,退出码 1
  check [--deck <目录>] [--phase <阶段>]
                    对阶段产物跑确定性检查。有不合规的,退出码 1
  export [--deck <目录>] [-o <文件.pptx>] [--report <文件.json>]
                    导出 PPTX,要系统里有 Chrome 或 Edge。不给 -o 就放在稿子目录旁边。
                    --report 写完整的导出报告,skill 的 check-pptx.mjs 拿它核对导出的包
  serve [--port 6722] [--deck <目录>] [--no-open]
                    在浏览器里打开工作台

  --json            机器可读的输出
  --deck 不给就是当前目录。阶段:${DeckPhase.options.join(' ')}
`

/** PowerPoint 里实际用的转场,说人话(和 skill 的 export-pptx.mjs 一样)。 */
const SHOWN: Record<string, string> = {
  morph: '平滑',
  fade: '淡入淡出',
  wipe: '擦除',
  none: '无转场',
}

const args = process.argv.slice(2)
const command = args[0]
const json = args.includes('--json')
const opt = (...names: string[]): string | undefined => {
  for (const name of names) {
    const at = args.indexOf(name)
    if (at !== -1) return args[at + 1]
  }
  return undefined
}
/** 第 n 个不是选项、也不是选项值的参数(命令本身是第 0 个)。 */
const positional = (n: number): string | undefined =>
  args.filter((arg, i) => !arg.startsWith('-') && !args[i - 1]?.startsWith('-'))[n]

/** 人看的一行行字,或者 --json 时的一份 JSON。 */
function print(text: string | string[], data: unknown): void {
  process.stdout.write(
    json ? `${JSON.stringify(data, null, 2)}\n` : `${[text].flat().join('\n')}\n`,
  )
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

async function skill(): Promise<string> {
  const path = await resolveSkillPath()
  if (!path) fail('找不到 skill:设置环境变量 ORCA_PPT_SKILL 指向 skills/orca-ppt')
  return path
}

const deckDir = () => resolve(expandHome(opt('--deck') ?? '.'))

function phase(value: string | undefined): DeckPhase {
  const parsed = DeckPhase.safeParse(value)
  if (!parsed.success) fail(`阶段要是这几个之一:${DeckPhase.options.join('、')}`)
  return parsed.data
}

switch (command) {
  case 'new': {
    const title = positional(1)
    if (!title) fail('要给稿子起个名字:orca-ppt new <标题>')
    const skillPath = await skill()
    const { themes } = await readCatalog(skillPath)
    const created = await createDeck({
      skillPath,
      themes,
      title,
      parentDir: opt('--dir'),
      from: opt('--from'),
      theme: opt('--theme'),
    })
    print(created.path, created)
    break
  }
  case 'recipes': {
    const recipes = (await listRecipes(await skill())).filter((item) => item.kind === 'recipe')
    print(
      recipes.map((item) => `recipe:${item.id}\t${item.title}`),
      recipes.map(({ id, title, summary }) => ({ id: `recipe:${id}`, title, summary })),
    )
    break
  }
  case 'templates': {
    const templates = await listTemplates(await skill())
    print(
      templates.map((item) => `${item.id}\t${item.title}`),
      templates,
    )
    break
  }
  case 'themes': {
    const { themes } = await readCatalog(await skill())
    print(
      themes.map((item) => `${item.name}\t${item.title}${item.summary ? `\t${item.summary}` : ''}`),
      themes.map(({ name, title, summary, tags }) => ({ name, title, summary, tags })),
    )
    break
  }
  case 'prompt': {
    const skillPath = await skill()
    const request = opt('--request')
    const result = await phaseGate(deckDir(), phase(positional(1)), {
      request,
      skillPath,
      themes: (await readCatalog(skillPath)).themes.map((theme) => theme.name),
      spec: await readSpec(skillPath),
      // CLI 的 agent 自己有文件工具,没有 MCP 的 read_skill
      skillAccess: 'files',
    })
    if (!result.prompt) {
      print(
        [`这个阶段还不能开始,卡在「${result.blockedBy}」:`, ...result.issues.map((i) => `- ${i}`)],
        result,
      )
      process.exit(1)
    }
    print(result.prompt, result)
    break
  }
  case 'check': {
    const only = opt('--phase')
    const all = await readPhaseStatus(deckDir(), await readSpec(await skill()))
    const phases = only ? all.filter((row) => row.phase === phase(only)) : all
    print(
      phases.flatMap((row) => [
        `${row.phase}\t${{ idle: '还没有', running: '进行中', done: '合规', failed: '不合规' }[row.status]}`,
        ...row.issues.map((issue) => `  - ${issue}`),
      ]),
      phases,
    )
    if (phases.some((row) => row.status === 'failed')) process.exit(1)
    break
  }
  case 'export': {
    const root = deckDir()
    const entry = await findEntryName(root)
    if (!entry) fail(`这个目录里没有出稿文件(deck.html):${root}`)
    const target = resolve(expandHome(opt('-o', '--out') ?? `${root}.pptx`))
    const problem = await pptxTargetProblem(target)
    if (problem) fail(problem)
    const renderer = playwrightRenderer()
    try {
      // 稿子按 file:// 打开:引到 skill 的相对路径和双击打开时一样解析
      const raw = await renderer.exportPptx({
        previewUrl: pathToFileURL(join(root, entry)).href,
        outPath: target,
      })
      // 契约只认摘要要用的字段;报告文件写原样的那份,check-pptx 要每页预期的文字这些
      const summary = summarizePptx(target, PptxExportReport.parse(raw))
      const reportFile = opt('--report')
      if (reportFile) {
        // 和 skill 的 export-pptx.mjs --json 同一个形状
        await writeFile(
          resolve(expandHome(reportFile)),
          JSON.stringify({ deck: join(root, entry), pptx: target, ...(raw as object) }, null, 2),
        )
      }
      print(
        [
          `导出:${summary.path}(${summary.slides} 页)`,
          ...summary.degraded.map(
            (d) =>
              `  第 ${d.from}→${d.to} 页 ${d.technique}:${d.tier},PowerPoint 里换成${SHOWN[d.kind] ?? d.kind}`,
          ),
          ...summary.lost.map((l) => `  第 ${l.slide} 页导不出来:${l.items.join('、')}`),
          ...(summary.rasters ? [`${summary.rasters} 个元素转成了图片`] : []),
          `用到的字体(看的那台电脑要装):${summary.fonts.join('、') || '无'}`,
        ],
        summary,
      )
    } finally {
      await renderer.close()
    }
    break
  }
  case 'serve': {
    // 同一个 server 入口:apps/cli/dist 旁边的 apps/server/dist/serve.js,参数原样交过去
    const here = dirname(fileURLToPath(import.meta.url))
    await import(pathToFileURL(join(here, '../../server/dist/serve.js')).href)
    break
  }
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(HELP)
    break
  default:
    process.stderr.write(`不认识的命令:${command}\n\n${HELP}`)
    process.exit(1)
}
