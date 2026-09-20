/**
 * 界面的长期偏好:左栏怎么显示、右栏在不在、中栏是画布还是看片台。
 *
 * 都记在本地 —— 每次开应用都要重新调一遍的设置等于没有。
 */

/** 左栏的三种样子。对应 Keynote 的「导航器 / 大纲 / 仅幻灯片」。 */
export type NavMode = 'thumbs' | 'outline' | 'off'
const NAV_MODES: NavMode[] = ['thumbs', 'outline', 'off']

export interface Layout {
  nav: NavMode
  /** 右栏(阶段 + 待办)。 */
  maker: boolean
  /** 中栏铺开全部页面,而不是放映单页。 */
  lightTable: boolean
}

const KEY = 'orca-ppt.layout'

export const DEFAULT_LAYOUT: Layout = { nav: 'thumbs', maker: true, lightTable: false }

export function readLayout(): Layout {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<Layout>
    return {
      nav: NAV_MODES.includes(parsed.nav as NavMode) ? (parsed.nav as NavMode) : DEFAULT_LAYOUT.nav,
      maker: typeof parsed.maker === 'boolean' ? parsed.maker : DEFAULT_LAYOUT.maker,
      lightTable:
        typeof parsed.lightTable === 'boolean' ? parsed.lightTable : DEFAULT_LAYOUT.lightTable,
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
