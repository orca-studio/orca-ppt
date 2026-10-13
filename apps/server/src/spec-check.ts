import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sliceSections } from './decks.js'

/**
 * 按 `references/visual-spec.md` 核稿子的坐标。
 *
 * **为什么值得做**:规范里那些数字不是审美偏好,是转场的前提 —— 时间线的节点必须落在
 * `120 / 560 / 1000 / 1440`,因为 Bento 的四列也是这一套,两页之间才接得上;条形图最长
 * 的那条必须叫 `axis`,因为下一页的轴要从它变过来。摆歪了不会报错,**要放映到那一下
 * 才发现**,而那时候已经在给人看了。
 *
 * 这也是给每一页标 `data-page` 的兑现:说不出一页是什么类型,就没法按类型核它。
 *
 * **只核写死的数字,不核审美。** 一个会误报的检查比没有检查更糟 —— 人会开始无视它,
 * 然后真问题也一起被无视。所以:
 * - 没标类型的页只做通用检查(安全区),不猜它是什么;
 * - 「坐标取 40 的倍数」这条**没有做**:图表的条按数据比例算、居中文字按公式算,
 *   合法的例外太多,做了就是误报机器。
 *
 * **数字不写在这里。** 安全区、四列、条形图这些都读 skill 的 `runtime/spec.json`,
 * check-deck 读的也是那一份 —— 规范只在 skill 里(AGENTS.md 边界 4)。以前这里抄了一份,
 * 和 check-deck 走了样(时间线放行 5 站、安全区没有画外豁免),同一份稿子两边结论不同。
 */

/** 一条问题。`slide` 从 0 数起。 */
export interface SpecIssue {
  slide: number
  message: string
}

/** skill 的 `runtime/spec.json`:visual-spec.md 里写死的数字。 */
export interface Spec {
  safeArea: { left: number; right: number; top: number; bottom: number }
  /** 四栏产品切换(`data-demo="product-showcase"`)的局部安全区。 */
  showcaseSafeArea?: { left: number; right: number; top: number; bottom: number }
  safeAreaExempt: string[]
  /** Bento 的四列,时间线的节点也用同一套 —— 两页之间才接得上。 */
  columns: number[]
  bento: { rows: number[]; cell: [number, number] }
  bars: { left: number; height: number; maxRows: number }
  timeline: { nodes: number }
  compare: { panel: [number, number]; top: number; lefts: number[] }
}

/** 读 skill 的规范数字。读不到就返回 undefined,出稿检查跳过坐标这一项,不自己编一份。 */
export async function readSpec(skillPath: string | undefined): Promise<Spec | undefined> {
  if (!skillPath) return undefined
  try {
    return JSON.parse(await readFile(join(skillPath, 'runtime/spec.json'), 'utf8')) as Spec
  } catch {
    return undefined
  }
}

export function checkDeck(
  html: string,
  pageTypes: Array<string | null>,
  spec: Spec | undefined,
): SpecIssue[] {
  if (!spec) return []
  const issues: SpecIssue[] = []
  const sections = sliceSections(html)
  // 四栏产品切换是全出血的参考案例,有自己的安全区(product-showcase.md),和 check-deck 一样认 data-demo
  const showcase = /<html[^>]*data-demo="product-showcase"/.test(html)
  // 每页的 data-id,判断「画外待命」要看别的页有没有配对
  const ids = sections.map(
    (section) => new Set([...section.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1])),
  )
  sections.forEach((section, slide) => {
    const type = pageTypes[slide] ?? null
    const add = (message: string) => issues.push({ slide, message })
    const pairedElsewhere = (id: string) => ids.some((set, other) => other !== slide && set.has(id))
    checkSafeArea(section, spec, showcase, pairedElsewhere, add)
    if (type === 'bars') checkBars(section, spec, add)
    if (type === 'timeline') checkTimeline(section, spec, add)
    if (type === 'bento') checkBento(section, spec, add)
    if (type === 'compare') checkCompare(section, spec, add)
  })
  return issues
}

/** 页面里带绝对坐标的元素。 */
interface Box {
  tag: string
  cls: string
  left: number | undefined
  top: number | undefined
  width: number | undefined
  height: number | undefined
  raw: string
}

/** 没有结束标签的元素:不算进嵌套深度。 */
const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'col', 'wbr', 'area'])

/**
 * 页面里带绝对坐标的元素,带上嵌套深度(section 自己是 0,直接子元素是 1)。
 * 嵌套元素的 left / top 是相对外层盒子的,不是画布坐标 —— 手电筒的灯头写在灯这个组里,
 * `left:52` 是在灯里的位置,拿去和安全区比就是误报。
 */
function boxes(section: string): Array<Box & { depth: number }> {
  const found: Array<Box & { depth: number }> = []
  let depth = 0
  for (const match of section.matchAll(/<(\/?)(\w+)\b([^>]*)>/g)) {
    const tag = (match[2] ?? '').toLowerCase()
    if (match[1]) {
      depth = Math.max(0, depth - 1)
      continue
    }
    const here = depth
    if (!VOID.has(tag) && !(match[3] ?? '').trimEnd().endsWith('/')) depth += 1
    const attrs = match[3] ?? ''
    const style = attrs.match(/style="([^"]*)"/)?.[1]
    if (!style) continue
    const px = (name: string) => {
      const value = style.match(new RegExp(`\\b${name}\\s*:\\s*(-?[\\d.]+)px`))?.[1]
      return value === undefined ? undefined : Number(value)
    }
    found.push({
      depth: here,
      tag,
      cls: attrs.match(/class="([^"]*)"/)?.[1] ?? '',
      left: px('left'),
      top: px('top'),
      width: px('width'),
      height: px('height'),
      raw: match[0],
    })
  }
  return found
}

/**
 * 铺满一整边的形状是规范允许的(「整页 ↔ 卡片」那组转场靠它),不算越界。
 *
 * **必须真的铺满**:一开始我把「没写 width」也算进来,结果 `left:0` 的文字全被放行了 ——
 * 那正是要抓的东西。
 */
// 和 check-deck 的 isFullBleed 同一条:宽或高不小于画布就是整页形状(环形时间轴的扇形
// 1160×1160,圆心贴边、故意出血)。以前只认正好等于画布,比画布大的反而被判越界。
const fullBleed = (box: Box) => (box.width ?? 0) >= 1919 || (box.height ?? 0) >= 1079

/**
 * 安全区不管的几个类(`spec.safeAreaExempt`):
 * - `.s-spot` 是镂空聚焦的圈,它按被聚焦的那个东西定位,而且靠一层铺满全屏的遮罩起作用;
 * - `.st-photo` 是故事稿的整页照片,本来就铺满。
 * 把它们算成越界是误报,而一个会误报的检查比没有检查更糟。
 *
 * 还有「画外待命」:整个落在画布外、别的页有同 data-id 配对的元素,是在等着入画或刚出画
 * (transitions.md「共享元素」第 4 条)。只露出一部分的不算。
 */
const offstage = (box: Box) =>
  box.left !== undefined &&
  box.top !== undefined &&
  box.width !== undefined &&
  box.height !== undefined &&
  (box.left + box.width <= 0 || box.top + box.height <= 0 || box.left >= 1920 || box.top >= 1080)

function checkSafeArea(
  section: string,
  spec: Spec,
  showcase: boolean,
  pairedElsewhere: (id: string) => boolean,
  add: (message: string) => void,
): void {
  const SAFE = showcase && spec.showcaseSafeArea ? spec.showcaseSafeArea : spec.safeArea
  // 容差和 check-deck 一样是 8px:2px 的细线压在边界上、描边撑出来的几像素不是构图错误
  const SLACK = 8
  for (const box of boxes(section)) {
    if (box.depth !== 1) continue
    if (fullBleed(box)) continue
    if (box.cls.split(' ').some((name) => spec.safeAreaExempt.includes(name))) continue
    const id = box.raw.match(/data-id="([^"]+)"/)?.[1]
    if (id && offstage(box) && pairedElsewhere(id)) continue
    const where = box.cls ? `.${box.cls.split(' ')[0]}` : `<${box.tag}>`
    if (box.left !== undefined && box.left < SAFE.left - SLACK) {
      add(`${where} 的 left ${box.left} 越过左安全区(${SAFE.left})`)
    }
    if (
      box.left !== undefined &&
      box.width !== undefined &&
      box.left + box.width > SAFE.right + SLACK
    ) {
      add(`${where} 右边到 ${box.left + box.width},越过右安全区(${SAFE.right})`)
    }
    if (box.top !== undefined && box.top < SAFE.top - SLACK) {
      add(`${where} 的 top ${box.top} 越过上安全区(${SAFE.top})`)
    }
    if (
      box.top !== undefined &&
      box.height !== undefined &&
      box.top + box.height > SAFE.bottom + SLACK
    ) {
      add(`${where} 底边到 ${box.top + box.height},越过下安全区(${SAFE.bottom})`)
    }
  }
}

function checkBars(section: string, spec: Spec, add: (message: string) => void): void {
  const { left, height, maxRows } = spec.bars
  // 上一页的轴形态变换成最长的那条时,它写 data-id="axis" 而不写 grow-right,也是一条
  const bars = boxes(section).filter(
    (box) => box.raw.includes('data-enter="grow-right"') || box.raw.includes('data-id="axis"'),
  )
  if (bars.length === 0) {
    add('横向条形图页:一条 data-enter="grow-right" 的条都没有')
    return
  }
  if (bars.length > maxRows) add(`横向条形图页:${bars.length} 条,规范最多 ${maxRows} 条`)
  for (const bar of bars) {
    if (bar.left !== left) add(`横向条形图页:条的 left 应为 ${left},现在是 ${bar.left}`)
    if (bar.height !== height) add(`横向条形图页:条的高应为 ${height},现在是 ${bar.height}`)
  }
  // 最长的那条要叫 axis —— 下一页的轴从它形态变换过来,改名就接不上了。
  const longest = bars.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a))
  if (!longest.raw.includes('data-id="axis"')) {
    add('横向条形图页:最长的那条没写 data-id="axis",下一页的轴接不上它')
  }
}

function checkTimeline(section: string, spec: Spec, add: (message: string) => void): void {
  const COLUMNS = spec.columns
  const dots = boxes(section).filter((box) => box.cls.split(' ').includes('s-dot'))
  if (dots.length !== spec.timeline.nodes) {
    add(`横向时间线页:${dots.length} 个节点,规范是 ${spec.timeline.nodes} 个`)
  }
  for (const dot of dots) {
    if (dot.left !== undefined && !COLUMNS.includes(dot.left)) {
      add(`横向时间线页:节点 left ${dot.left} 不在 ${COLUMNS.join(' / ')} 上`)
    }
  }
}

function checkBento(section: string, spec: Spec, add: (message: string) => void): void {
  const COLUMNS = spec.columns
  const BENTO_ROWS = spec.bento.rows
  const [cw, ch] = spec.bento.cell
  const cells = boxes(section).filter(
    (box) => box.width === cw && box.height === ch && box.cls.startsWith('s-'),
  )
  if (cells.length === 0) {
    add(`Bento 网格页:没有 ${cw}×${ch} 的格子`)
    return
  }
  for (const cell of cells) {
    if (cell.left !== undefined && !COLUMNS.includes(cell.left)) {
      add(`Bento 网格页:格子 left ${cell.left} 不在 ${COLUMNS.join(' / ')} 上`)
    }
    if (cell.top !== undefined && !BENTO_ROWS.includes(cell.top)) {
      add(`Bento 网格页:格子 top ${cell.top} 不在 ${BENTO_ROWS.join(' / ')} 上`)
    }
  }
}

function checkCompare(section: string, spec: Spec, add: (message: string) => void): void {
  const [pw, ph] = spec.compare.panel
  const panels = boxes(section).filter((box) => box.width === pw && box.height === ph)
  if (panels.length !== 2) {
    add(`对比页:${panels.length} 个 ${pw}×${ph} 的面板,规范是两个`)
    return
  }
  for (const panel of panels) {
    if (panel.top !== spec.compare.top) {
      add(`对比页:面板 top 应为 ${spec.compare.top},现在是 ${panel.top}`)
    }
    if (panel.left === undefined || !spec.compare.lefts.includes(panel.left)) {
      add(`对比页:面板 left 应为 ${spec.compare.lefts.join(' 或 ')},现在是 ${panel.left}`)
    }
  }
}
