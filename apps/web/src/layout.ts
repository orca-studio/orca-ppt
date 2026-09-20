const KEY = 'orca-ppt.nav'

/**
 * 左栏(页胶片)开着还是收起。
 *
 * 记在本地:收起侧栏是长期偏好,不是一次性的动作 —— 每次开应用都要再点一次的开关
 * 等于没有。
 */
export function readNavOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'closed'
  } catch {
    // 隐私模式下会抛 —— 默认开着
    return true
  }
}

export function writeNavOpen(open: boolean): void {
  try {
    localStorage.setItem(KEY, open ? 'open' : 'closed')
  } catch {
    // 记不住就记不住,这一次仍然生效
  }
}
