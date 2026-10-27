#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DeckPhase, PptxExportReport } from '@orca-ppt/contracts'
import { readSpec } from '@orca-ppt/deck-agent'
import {
  createDeck,
  expandHome,
  findEntryName,
  linkStableSkill,
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
import { readServeState, serve } from '@orca-ppt/server/serve'
import { callTool, listTools } from './mcp.js'

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
  serve [--port 6722] [--deck <目录>] [--no-open] [--detach]
                    在浏览器里打开工作台。--detach 放到后台常驻,打印网址就返回;
                    已经在跑就只打印它的网址
  stop              停掉后台的 serve
  tools [--port]    列出 Orca PPT 的全部工具和用法(和 MCP 的是同一份)。要先有 serve 或桌面版在跑
  call <工具> [参数] [--port]
                    调一个工具。不用在助手里配 MCP、点「信任」;界面照样跟着走。参数三种写法:
                      orca-ppt call show_slide index=2          (key=value,值按 JSON 读,读不了就是字符串)
                      orca-ppt call show_slide '{"index":2}'    (一个 JSON 对象)
                      echo '{"index":2}' | orca-ppt call show_slide -   (从标准输入读 JSON)
                    Windows 的 PowerShell 会吃掉参数里的双引号,用 key=value 或标准输入。
                    返回的图片存成文件,打印路径;工具报错时退出码 1
  skill             打印随这个包一起发的 skill 目录(规范、用法都在它的 SKILL.md 里),链进你读 skill 的目录
  --version         版本号

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

/**
 * 发布出去的包(tools/pack-npm.mjs)是这个形状:bin/orca-ppt.js 旁边有 web/ 和 skill/。
 * 在仓里跑时(apps/cli/dist/main.js)界面在 apps/web/dist,skill 由 locateSkill 按开发位置找。
 */
const here = dirname(fileURLToPath(import.meta.url))
const packaged = existsSync(join(here, '../skill/SKILL.md'))
if (packaged) {
  // 和桌面版一样:skill 跟着这个包一起发,版本对得上
  process.env.ORCA_PPT_BUNDLED_SKILL ??= join(here, '../skill')
  process.env.ORCA_PPT_APP_VERSION ??= version()
}
const webRoot = packaged ? join(here, '../web') : join(here, '../../web/dist')

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { version: string })
      .version
  } catch {
    return '0.0.0'
  }
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
      // 新稿子经固定位置引 skill:升级、换 Node 版本之后也不坏
      skillLink: await linkStableSkill(skillPath),
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
    if (args.includes('--detach')) await detach()
    else await serve(args.slice(1), { webRoot })
    break
  }
  case 'tools': {
    const { instructions, tools } = await listTools(await mcpPort())
    print(
      [
        ...(instructions ? [instructions, ''] : []),
        ...tools.flatMap((tool) => [
          `${tool.name}${tool.title ? `  ${tool.title}` : ''}`,
          ...(tool.description ? [`  ${tool.description.replace(/\n/g, '\n  ')}`] : []),
          ...tool.params.map(
            (param) =>
              `  - ${param.name}${param.required ? '' : '?'}: ${param.type}${param.description ? `  ${param.description}` : ''}`,
          ),
          '',
        ]),
        '调用:orca-ppt call <工具> key=value …(或一个 JSON 对象,或 - 从标准输入读 JSON)',
      ],
      { instructions, tools },
    )
    break
  }
  case 'call': {
    const name = positional(1)
    if (!name) fail("要给工具名:orca-ppt call <工具> '<JSON 参数>'(工具列表见 orca-ppt tools)")
    const input = await callArgs(args.slice(args.indexOf(name) + 1))
    const result = await callTool(await mcpPort(), name, input)
    print([...result.text, ...result.images.map((file) => `图片:${file}`)], result)
    if (result.isError) process.exit(1)
    break
  }
  case 'stop': {
    const state = await readServeState()
    if (!state) {
      print('没有在后台跑的 serve', { stopped: false })
      break
    }
    process.kill(state.pid, 'SIGTERM')
    print(`停了(进程 ${state.pid})`, { stopped: true, pid: state.pid })
    break
  }
  case 'skill': {
    // 给助手链的是固定位置:升级、换 Node 版本之后链接也不失效。建不了就给真正的位置
    const real = await skill()
    const path = (await linkStableSkill(real)) ?? real
    print(path, { path })
    break
  }
  case '--version':
  case '-v':
    print(version(), { version: version() })
    break
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

/**
 * `call` 的参数:一个 JSON 对象;`-` 从标准输入读 JSON;或者若干 `key=value`(值按 JSON 读,
 * 读不了就当字符串)。后两种不靠引号 —— Windows 上 PowerShell 调 npm 生成的 .cmd 会吃掉双引号。
 */
async function callArgs(rest: string[]): Promise<Record<string, unknown>> {
  const words: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!
    if (word === '--port') i++
    else if (word !== '--json') words.push(word)
  }
  const asObject = (text: string, from: string) => {
    try {
      const value: unknown = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value))
        return value as Record<string, unknown>
    } catch {
      // 下面一起报
    }
    fail(`参数要是 JSON 对象(${from}):${text}`)
  }
  if (words.length === 1 && words[0] === '-') {
    let text = ''
    for await (const chunk of process.stdin) text += String(chunk)
    return asObject(text.trim() || '{}', '标准输入')
  }
  if (words.length === 1 && words[0]!.trimStart().startsWith('{'))
    return asObject(words[0]!, '参数')
  const input: Record<string, unknown> = {}
  for (const word of words) {
    const at = word.indexOf('=')
    if (at <= 0) fail(`参数写成 key=value、一个 JSON 对象,或者 - 从标准输入读:${word}`)
    const raw = word.slice(at + 1)
    try {
      input[word.slice(0, at)] = JSON.parse(raw)
    } catch {
      input[word.slice(0, at)] = raw
    }
  }
  return input
}

/** `tools` / `call` 连哪个端口:--port,其次后台 serve 记下的端口,再是默认的 6722(桌面版也在这)。 */
async function mcpPort(): Promise<number> {
  const given = opt('--port')
  if (given) return Number(given)
  return (await readServeState())?.port ?? 6722
}

/**
 * 放到后台常驻:AI 助手的命令一般有超时,前台跑的 serve 会被它掐掉。
 * 已经在跑就只报它的网址,不起第二个;起不来就把日志末尾交代出来。
 */
async function detach(): Promise<void> {
  const running = await readServeState()
  if (running) {
    print([`已经在跑:${running.url}`], { ...running, started: false })
    return
  }
  const log = join(homedir(), '.orca-ppt', 'serve.log')
  await mkdir(dirname(log), { recursive: true })
  const out = openSync(log, 'a')
  const child = spawn(
    process.execPath,
    [process.argv[1]!, ...args.filter((arg) => arg !== '--detach')],
    { detached: true, stdio: ['ignore', out, out], windowsHide: true },
  )
  child.unref()
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  for (let waited = 0; waited < 20_000; waited += 200) {
    const state = await readServeState()
    if (state && state.pid === child.pid) {
      print([`在后台跑起来了:${state.url}`, `日志:${log}`], { ...state, started: true, log })
      return
    }
    if (exited) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-5).join('\n')
  fail(`后台的 serve 没起来。日志(${log})末尾:\n${tail}`)
}
