/**
 * 界面的长期偏好:左栏(页胶片)开不开。
 *
 * 记在本地 —— 每次开应用都要重新调一遍的设置等于没有。
 *
 * 左栏只有开和关 —— 以前的「大纲」(只有标题)给长稿子用,而同款和一般演示稿就五到二十页,
 * 导航器里已经有标题了。
 *
 * 以前还有右栏(转场 / 页 / 稿子三档检查器)和它的宽度,2026-11-09 去掉了:里面大多是
 * 给开发者看的调试信息,真正有用的「重放转场 / 重放页内动画」挪到了顶栏,页面操作挪到了
 * 页胶片的右键菜单。工作台常放在 AI 助手的侧边栏里,本来就窄,再开一栏只会挤画布。
 * 旧版存下的 inspector / inspectorWidth 读的时候不认,写的时候也不再带上。
 */
export interface Layout {
  /** 左栏(页胶片)开着。 */
  nav: boolean
}

const KEY = 'orca-ppt.layout'
const VERSION = 3

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
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, ...layout }))
  } catch {
    // 记不住就记不住,这一次仍然生效
  }
}
