import type { UiRect, UiTarget, UiTargetQuery, UiTargets } from '@orca-ppt/contracts'
import type { StageQuery, StageTarget } from './Stage.js'

/**
 * `studio.orca/ui-targets` v1 的界面这一侧:把查询答成屏幕点坐标。
 *
 * 界面控件靠 `data-ui-target` 认 —— 名字是约定的一部分,别靠 aria-label 去找,那是给读屏的,
 * 文案一改就对不上。画布上的元素交给 Stage 去 guest 里量。
 */

/** 回执里给出的元素 targetId:`canvas.slide.<n>.element:<页内选择器>`。 */
const ELEMENT_ID = /^canvas\.slide\.(\d+)\.element:(.+)$/s

export function elementTargetId(slide: number, selector: string): string {
  return `canvas.slide.${slide}.element:${selector}`
}

/** 查询要交给画布量的那部分;界面控件返回 undefined。 */
export function stageQueryOf(query: UiTargetQuery): StageQuery | undefined {
  if ('text' in query) return { slide: query.slide, text: query.text }
  if ('selector' in query) return { slide: query.slide, selector: query.selector }
  const element = ELEMENT_ID.exec(query.controlId)
  if (element) return { slide: Number(element[1]), selector: element[2]! }
  return undefined
}

export interface Screen {
  /** 窗口内容区在屏幕上的位置(点)和页面缩放。 */
  bounds: { x: number; y: number; width: number; height: number; zoom: number }
}

export function toScreen(rect: UiRect, screen: Screen): UiRect {
  const { bounds } = screen
  return {
    x: bounds.x + rect.x * bounds.zoom,
    y: bounds.y + rect.y * bounds.zoom,
    width: rect.width * bounds.zoom,
    height: rect.height * bounds.zoom,
  }
}

/**
 * 一个控件露在外面的部分:和视口、每一层会裁切的祖先(滚动列表)取交集。
 * 滚出列表的缩略图不算可见 —— ocut 那边就栽过这个。
 */
export function visiblePart(element: Element): UiRect | undefined {
  const own = element.getBoundingClientRect()
  let left = Math.max(own.left, 0)
  let top = Math.max(own.top, 0)
  let right = Math.min(own.right, innerWidth)
  let bottom = Math.min(own.bottom, innerHeight)
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return undefined
    const clips = [style.overflow, style.overflowX, style.overflowY].some((value) =>
      ['hidden', 'auto', 'scroll', 'clip'].includes(value),
    )
    if (!clips) continue
    const clip = node.getBoundingClientRect()
    left = Math.max(left, clip.left)
    top = Math.max(top, clip.top)
    right = Math.min(right, clip.right)
    bottom = Math.min(bottom, clip.bottom)
  }
  if (right <= left || bottom <= top) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 按 `data-ui-target` 量一个界面控件。 */
export function resolveControl(
  query: UiTargetQuery & { controlId: string },
  root: ParentNode = document,
): Omit<UiTarget, 'window'> {
  const matches = [...root.querySelectorAll('[data-ui-target]')].filter(
    (element) => element.getAttribute('data-ui-target') === query.controlId,
  )
  if (matches.length === 0) return { query, status: 'not_found', reason: 'no_such_control' }
  if (matches.length > 1) return { query, status: 'ambiguous', reason: 'multiple_matches' }
  const rect = visiblePart(matches[0]!)
  if (!rect) return { query, status: 'not_visible', targetId: query.controlId }
  return { query, status: 'visible', targetId: query.controlId, rect }
}

/** 画布量出来的结果 → 约定里的一条。targetId 拼成能原样再查的元素 id。 */
export function fromStage(query: UiTargetQuery, slide: number, found: StageTarget): UiTarget {
  return {
    query,
    status: found.status,
    ...(found.selector ? { targetId: elementTargetId(slide, found.selector) } : {}),
    ...(found.status === 'visible' && found.rect ? { rect: found.rect } : {}),
    ...(found.reason ? { reason: found.reason } : {}),
  }
}

/**
 * 一批查询:画布上的交给 `locate`,界面控件就地量;最后统一换成屏幕点。
 * 窗口量不到(最小化、藏起来)时一律 not_visible,不编矩形。
 */
export async function resolveTargets(
  queries: UiTargetQuery[],
  locate: (queries: StageQuery[]) => Promise<StageTarget[]>,
  screen: Screen | undefined,
): Promise<UiTargets> {
  const onStage = queries
    .map((query, index) => ({ index, stage: stageQueryOf(query) }))
    .filter((entry): entry is { index: number; stage: StageQuery } => Boolean(entry.stage))
  const located = onStage.length > 0 ? await locate(onStage.map((entry) => entry.stage)) : []
  const fromCanvas = new Map(onStage.map((entry, i) => [entry.index, located[i]]))

  const targets = queries.map((query, index): UiTarget => {
    const stage = stageQueryOf(query)
    const target: UiTarget = stage
      ? fromStage(query, stage.slide, fromCanvas.get(index) ?? { status: 'unavailable' })
      : resolveControl(query as UiTargetQuery & { controlId: string })
    return place(target, screen)
  })
  return { measuredAt: Date.now(), coordinateSpace: 'screen_points_top_left', targets }
}

/** 页面坐标 → 屏幕点,带上窗口。 */
export function place(target: UiTarget, screen: Screen | undefined): UiTarget {
  if (!screen) {
    const { rect: _rect, ...rest } = target
    return rest.status === 'visible'
      ? { ...rest, status: 'not_visible', reason: 'window_hidden' }
      : rest
  }
  const { zoom: _zoom, ...bounds } = screen.bounds
  return {
    ...target,
    window: { id: 'workbench', bounds },
    ...(target.rect ? { rect: toScreen(target.rect, screen) } : {}),
  }
}
