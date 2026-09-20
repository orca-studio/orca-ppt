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
 */

/** 一条问题。`slide` 从 0 数起。 */
export interface SpecIssue {
  slide: number
  message: string
}

/** 安全区:内容不许超出这个框。 */
const SAFE = { left: 120, right: 1800, top: 80, bottom: 1000 }

/** Bento 的四列,时间线的节点也用同一套 —— 两页之间才接得上。 */
const COLUMNS = [120, 560, 1000, 1440]
const BENTO_ROWS = [240, 640]

export function checkDeck(html: string, pageTypes: Array<string | null>): SpecIssue[] {
  const issues: SpecIssue[] = []
  sliceSections(html).forEach((section, slide) => {
    const type = pageTypes[slide] ?? null
    const add = (message: string) => issues.push({ slide, message })
    checkSafeArea(section, add)
    if (type === 'bars') checkBars(section, add)
    if (type === 'timeline') checkTimeline(section, add)
    if (type === 'bento') checkBento(section, add)
    if (type === 'compare') checkCompare(section, add)
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

function boxes(section: string): Box[] {
  const found: Box[] = []
  for (const match of section.matchAll(/<(\w+)\b([^>]*)>/g)) {
    const attrs = match[2] ?? ''
    const style = attrs.match(/style="([^"]*)"/)?.[1]
    if (!style) continue
    const px = (name: string) => {
      const value = style.match(new RegExp(`\\b${name}\\s*:\\s*(-?[\\d.]+)px`))?.[1]
      return value === undefined ? undefined : Number(value)
    }
    found.push({
      tag: match[1] ?? '',
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
const fullBleed = (box: Box) => box.width === 1920 || box.height === 1080

/**
 * 安全区不管的几个类:
 * - `.s-spot` 是镂空聚焦的圈,它按被聚焦的那个东西定位,而且靠一层铺满全屏的遮罩起作用;
 * - `.st-photo` 是故事稿的整页照片,本来就铺满。
 * 把它们算成越界是误报,而一个会误报的检查比没有检查更糟。
 */
const EXEMPT = ['s-spot', 'st-photo']

function checkSafeArea(section: string, add: (message: string) => void): void {
  for (const box of boxes(section)) {
    if (fullBleed(box)) continue
    if (box.cls.split(' ').some((name) => EXEMPT.includes(name))) continue
    const where = box.cls ? `.${box.cls.split(' ')[0]}` : `<${box.tag}>`
    if (box.left !== undefined && box.left < SAFE.left) {
      add(`${where} 的 left ${box.left} 越过左安全区(${SAFE.left})`)
    }
    if (box.left !== undefined && box.width !== undefined && box.left + box.width > SAFE.right) {
      add(`${where} 右边到 ${box.left + box.width},越过右安全区(${SAFE.right})`)
    }
    if (box.top !== undefined && box.top < SAFE.top) {
      add(`${where} 的 top ${box.top} 越过上安全区(${SAFE.top})`)
    }
    if (box.top !== undefined && box.height !== undefined && box.top + box.height > SAFE.bottom) {
      add(`${where} 底边到 ${box.top + box.height},越过下安全区(${SAFE.bottom})`)
    }
  }
}

function checkBars(section: string, add: (message: string) => void): void {
  const bars = boxes(section).filter((box) => box.raw.includes('data-enter="grow-right"'))
  if (bars.length === 0) {
    add('横向条形图页:一条 data-enter="grow-right" 的条都没有')
    return
  }
  if (bars.length > 6) add(`横向条形图页:${bars.length} 条,规范最多 6 条`)
  for (const bar of bars) {
    if (bar.left !== 680) add(`横向条形图页:条的 left 应为 680,现在是 ${bar.left}`)
    if (bar.height !== 56) add(`横向条形图页:条的高应为 56,现在是 ${bar.height}`)
  }
  // 最长的那条要叫 axis —— 下一页的轴从它形态变换过来,改名就接不上了。
  const longest = bars.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a))
  if (!longest.raw.includes('data-id="axis"')) {
    add('横向条形图页:最长的那条没写 data-id="axis",下一页的轴接不上它')
  }
}

function checkTimeline(section: string, add: (message: string) => void): void {
  const dots = boxes(section).filter((box) => box.cls.split(' ').includes('s-dot'))
  if (dots.length < 4 || dots.length > 5) {
    add(`横向时间线页:${dots.length} 个节点,规范是 4 到 5 个`)
  }
  for (const dot of dots) {
    if (dot.left !== undefined && !COLUMNS.includes(dot.left)) {
      add(`横向时间线页:节点 left ${dot.left} 不在 ${COLUMNS.join(' / ')} 上`)
    }
  }
}

function checkBento(section: string, add: (message: string) => void): void {
  const cells = boxes(section).filter(
    (box) => box.width === 360 && box.height === 360 && box.cls.startsWith('s-'),
  )
  if (cells.length === 0) {
    add('Bento 网格页:没有 360×360 的格子')
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

function checkCompare(section: string, add: (message: string) => void): void {
  const panels = boxes(section).filter((box) => box.width === 800 && box.height === 760)
  if (panels.length !== 2) {
    add(`对比页:${panels.length} 个 800×760 的面板,规范是两个`)
    return
  }
  for (const panel of panels) {
    if (panel.top !== 240) add(`对比页:面板 top 应为 240,现在是 ${panel.top}`)
    if (panel.left !== 120 && panel.left !== 1000) {
      add(`对比页:面板 left 应为 120 或 1000,现在是 ${panel.left}`)
    }
  }
}
