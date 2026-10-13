/**
 * 界面的长期偏好:两边的栏开不开、右栏多宽。
 *
 * 都记在本地 —— 每次开应用都要重新调一遍的设置等于没有。
 *
 * 左栏只有开和关 —— 以前的「大纲」(只有标题)给长稿子用,而同款和一般演示稿就五到二十页,
 * 导航器里已经有标题了。右栏(转场 / 页 / 稿子)默认开着:转场的关系和手法是这个产品最
 * 独特的东西;但只想看稿子的时候要能收起来,内容多的时候要能拖宽。
 */
export interface Layout {
  /** 左栏(页胶片)开着。 */
  nav: boolean
  /** 右栏(检查器)开着。 */
  inspector: boolean
  /** 右栏拖出来的宽度(px)。null 是没拖过,按窗口宽度走默认。 */
  inspectorWidth: number | null
}

const KEY = 'orca-ppt.layout'

/** 右栏能拖到的范围。再窄转场说明折得没法读,再宽画布就不是主角了。 */
export const INSPECTOR_MIN = 260
export const INSPECTOR_MAX = 560

export const DEFAULT_LAYOUT: Layout = { nav: true, inspector: true, inspectorWidth: null }

export function clampInspectorWidth(width: number): number {
  return Math.round(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, width)))
}

export function readLayout(): Layout {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as {
      nav?: unknown
      inspector?: unknown
      inspectorWidth?: unknown
    }
    return {
      // 旧版存的是 'thumbs' | 'outline' | 'off',只有 'off' 是收起
      nav:
        typeof parsed.nav === 'boolean'
          ? parsed.nav
          : typeof parsed.nav === 'string'
            ? parsed.nav !== 'off'
            : DEFAULT_LAYOUT.nav,
      inspector:
        typeof parsed.inspector === 'boolean' ? parsed.inspector : DEFAULT_LAYOUT.inspector,
      inspectorWidth:
        typeof parsed.inspectorWidth === 'number' && Number.isFinite(parsed.inspectorWidth)
          ? clampInspectorWidth(parsed.inspectorWidth)
          : null,
    }
  } catch {
    // 存的是垃圾、或者隐私模式下读不了 —— 回到默认,不至于让界面空一块
    return DEFAULT_LAYOUT
  }
}

export function writeLayout(layout: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout))
  } catch {
    // 记不住就记不住,这一次仍然生效
  }
}
