/**
 * 界面的长期偏好:左栏开不开。
 *
 * 都记在本地 —— 每次开应用都要重新调一遍的设置等于没有。
 *
 * 右栏(转场 / 页 / 稿子)不给开关:转场的关系和手法是这个产品最独特的东西,看同款
 * 也全靠它。左栏也只有开和关 —— 以前的「大纲」(只有标题)给长稿子用,而同款和
 * 一般演示稿就五到二十页,导航器里已经有标题了。
 */
export interface Layout {
  /** 左栏(页胶片)开着。 */
  nav: boolean
}

const KEY = 'orca-ppt.layout'

export const DEFAULT_LAYOUT: Layout = { nav: true }

export function readLayout(): Layout {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as { nav?: unknown }
    return {
      // 旧版存的是 'thumbs' | 'outline' | 'off',只有 'off' 是收起
      nav:
        typeof parsed.nav === 'boolean'
          ? parsed.nav
          : typeof parsed.nav === 'string'
            ? parsed.nav !== 'off'
            : DEFAULT_LAYOUT.nav,
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
