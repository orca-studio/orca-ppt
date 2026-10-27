import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import nodePath, { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * 新建稿子从哪儿起头。**只有 skill 的空白起始文件** —— 汇报稿和故事稿两份。
 *
 * **不读 `examples/`。** 那些是 skill 自己的东西:按**转场手法**命名的技术参考和回归
 * 用例(`_tests/` 里是 match-cut、swap-text、zoom-through,`spec-wall` 是「整页视频 +
 * 镂空聚焦」的能力演示,`compare-v1-v2.mp4` 是它改版前后的对比)。SKILL.md 让 agent
 * 写页面时从 `templates/starter.html` 起头,**从来没让它从示例起头**。
 *
 * 「从示例开始建稿」是当初为了填满选择器发明的,skill 和它的工作流从没要求过。
 * 代价一路都在:技术演示得被硬打上「商业/创意」这种场景标签、开发中的工作稿混进选择器、
 * 页面类型认不准 —— 因为它们本来就不是按场景组织的东西。
 *
 * 所以选择器里只有空白起始文件。**做同款是例外**:同款的样稿就是答案,复刻从它起头
 * (`recipe:<id>`,见下面的 instantiateSample)。它走的是同款列表,不进这个选择器。
 *
 * 起始文件能复制到任何地方 —— 它引到 deck 目录之外的只有 skill 自己(reveal、gsap、
 * runtime),重写一次相对前缀就行。不重写的话,稿子一挪位置就全白。
 */

export interface DeckTemplate {
  id: string
  title: string
  /** 汇报稿还是故事稿。两个起始文件,一份稿子只能是一种。 */
  mode: string
}

/** 模式只有这两种,对应两个起始文件。认不出来的不猜。 */
const MODES = new Set(['standard', 'story'])

const BLANKS: Array<{ file: string; title: string; mode: string }> = [
  { file: 'starter.html', title: '汇报稿', mode: 'standard' },
  { file: 'story-starter.html', title: '故事稿', mode: 'story' },
]

export async function listTemplates(skillPath: string | undefined): Promise<DeckTemplate[]> {
  if (!skillPath) return []

  const blanks: DeckTemplate[] = []
  for (const blank of BLANKS) {
    try {
      await stat(join(skillPath, 'templates', blank.file))
      blanks.push({ id: `template:${blank.file}`, title: blank.title, mode: blank.mode })
    } catch {
      // skill 里没有这份模板
    }
  }
  return blanks
}

/** 录制产物和缩略图不该跟着复制到新稿子里。 */
/**
 * 按模板建出一份新稿子,返回入口文件路径。
 *
 * 路径重写是关键:模板里的 `{{ROOT}}` 和示例里的 `../../` 都指着 skill 根目录,
 * 而新稿子可能放在磁盘上任何地方。
 */
export async function instantiate(options: {
  skillPath: string
  templateId: string
  targetDir: string
  /** 空白模板要配一个主题 —— 起始文件本身不带主题,不配的话新稿子是没有样子的。 */
  theme?: string
  /** 配色。**引在主题之后**,它只定义那 8 个颜色变量,盖掉主题里的同名值。 */
  palette?: string
  /** 稿子的名字,替掉起始文件里的 `{{TITLE}}`。 */
  title?: string
}): Promise<string> {
  const { skillPath, templateId, targetDir, theme, palette, title } = options
  const [kind, name] = splitId(templateId)
  if (kind !== 'template') throw new Error(`只能从空白起始文件新建,不认识:${templateId}`)
  // 建目录之前先查跨盘:拒绝了就别留下一个空目录
  relativeUrl(resolve(targetDir), await realpath(skillPath))
  await mkdir(join(targetDir, '.deck'), { recursive: true })

  /*
   * 算相对路径之前两边都要 realpath。
   *
   * 少了这一步,稿子放在软链路径下时(macOS 的 /tmp → /private/tmp 就是)层数会差一级,
   * 重写出来的路径解析到一个不存在的地方 —— 而且**入口页照样 200**,只有资源全白,
   * 最难发现的那种坏法。
   */
  const realTarget = await realpath(targetDir)
  const realSkill = await realpath(skillPath)
  const toSkill = relativeUrl(realTarget, realSkill)
  const entry = join(targetDir, 'deck.html')

  const source = await readFile(join(skillPath, 'templates', name), 'utf8')
  let html = source.split('{{ROOT}}').join(toSkill)
  if (title) html = html.split('{{TITLE}}').join(title)
  if (theme) html = withTheme(html, toSkill, theme)
  // 配色必须排在主题后面 —— 顺序反了,那 8 个颜色就被主题盖回去了。
  if (palette) html = withLink(html, `${toSkill}/runtime/palettes/${palette}.css`)
  await writeFile(entry, html)
  return entry
}

/**
 * 做同款:以同款的样稿为起点建一份新稿子,返回入口文件路径。
 *
 * 做同款就是复刻,样稿就是答案 —— 让 agent 照着配方的文字从空白文件重写一遍,
 * 等于把例子翻译成文字再翻译回来,两次都会走样。所以直接复制样稿,agent 换内容、增删页。
 *
 * 只复制样稿**引用到的**、落在样稿目录里的文件(图片、视频)。配方正文、录好的样片、
 * 教学页不跟过来。样稿目录之外的引用(skill 的 runtime、reveal、示例共用素材)
 * 重写成从新位置回去的相对路径,和起始文件一个道理。主题和配色沿用样稿自己的。
 */
export async function instantiateSample(options: {
  sampleDir: string
  entry: string
  targetDir: string
  title?: string
}): Promise<string> {
  const { sampleDir, entry, targetDir, title } = options
  const realSample = await realpath(sampleDir)
  relativeUrl(resolve(targetDir), realSample)
  await mkdir(join(targetDir, '.deck'), { recursive: true })
  const realTarget = await realpath(targetDir)
  const copies = new Set<string>()

  const rewrite = (url: string): string => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url) || url.includes('{{')) return url
    const [path = '', rest = ''] = url.split(/(?=[?#])/)
    const absolute = resolve(realSample, path)
    const inside = relative(realSample, absolute)
    if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
      copies.add(inside)
      return url
    }
    return relativeUrl(realTarget, absolute) + rest
  }

  let html = (await readFile(entry, 'utf8'))
    .replace(
      /(\b(?:src|href|poster)=")([^"]+)(")/g,
      (_, a: string, url: string, b: string) => a + rewrite(url) + b,
    )
    .replace(
      /(url\(\s*(?:&quot;|['"])?)([^'")&]+)/g,
      (_, a: string, url: string) => a + rewrite(url),
    )
  if (title) html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)

  for (const file of copies) {
    const from = join(realSample, file)
    if (
      !(await stat(from).then(
        (info) => info.isFile(),
        () => false,
      ))
    )
      continue
    await mkdir(dirname(join(targetDir, file)), { recursive: true })
    await copyFile(from, join(targetDir, file))
  }
  const out = join(targetDir, 'deck.html')
  await writeFile(out, html)
  return out
}

/**
 * 从稿子目录到另一处的相对 URL,写进 href / src 用。
 *
 * Windows 上跨盘没有相对路径:`relative('D:\decks\a', 'C:\skill')` 直接返回 `C:\skill`,
 * 写进 href 成了 `C:/skill`,浏览器把 `C:` 当成协议名 —— 资源全白,入口页照样 200。
 * 所以跨盘直接拒绝。也不写成 `file:///C:/…`:画布是 http 页面,加载不了 file:// 子资源。
 */
export function relativeUrl(
  from: string,
  to: string,
  path: typeof nodePath.win32 = nodePath,
): string {
  const rel = path.relative(from, to)
  if (path.isAbsolute(rel)) {
    const [here, there] = [path.parse(from).root, path.parse(to).root]
    throw new Error(
      `稿子和 skill 不在同一个盘上(${here} 和 ${there}),稿子里的相对路径指不过去。把稿子放到 ${there} 下`,
    )
  }
  return rel.split(path.sep).join('/')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 把主题挂上去 —— **接在 tokens.css 后面**,顺序是有意义的:主题覆盖 tokens 的缺省值,
 * 反过来挂就被盖回去了,新稿子看上去就像没选主题。
 */
function withTheme(html: string, toSkill: string, theme: string): string {
  return withLink(html, `${toSkill}/runtime/themes/${theme}.css`)
}

/** 在 head 末尾追加样式表，保持主题覆盖基础样式的层叠顺序。 */
function withLink(html: string, href: string): string {
  const link = `  <link rel="stylesheet" href="${href}">`
  // 注释里的示例 link 不是生效的样式表，不能当插入锚点。
  const head = /<\/head\s*>/i.exec(html)
  if (!head) throw new Error('模板缺少 </head>，无法插入主题')
  return html.slice(0, head.index) + link + '\n' + html.slice(head.index)
}

function splitId(id: string): ['template' | 'example', string] {
  const at = id.indexOf(':')
  const kind = id.slice(0, at)
  if (kind !== 'template' && kind !== 'example') throw new Error(`不认识的模板:${id}`)
  return [kind, id.slice(at + 1)]
}
