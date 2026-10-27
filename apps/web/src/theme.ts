import { host } from './host.js'

export type ThemeSource = 'system' | 'light' | 'dark'

const KEY = 'orca-ppt.theme'
const SOURCES: ThemeSource[] = ['system', 'light', 'dark']

/**
 * 主题偏好。默认跟随系统 —— 一个桌面应用不该自己决定用户的屏幕是亮是暗。
 *
 * 显式选过的才记下来,`system` 时不写 `data-theme`,CSS 那边靠
 * `prefers-color-scheme` 自己跟。
 */
export function readTheme(): ThemeSource {
  try {
    const stored = localStorage.getItem(KEY)
    return SOURCES.includes(stored as ThemeSource) ? (stored as ThemeSource) : 'system'
  } catch {
    // 隐私模式下 localStorage 会抛 —— 跟随系统就是最好的兜底
    return 'system'
  }
}

export function applyTheme(source: ThemeSource): void {
  const root = document.documentElement
  if (source === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = source

  try {
    localStorage.setItem(KEY, source)
  } catch {
    // 记不住就记不住,这一次仍然生效
  }
  // 壳那一层也要设,否则原生菜单、对话框、滚动条和界面对不上。
  void host.setTheme?.(source)
}

/** 轮换顺序:跟随系统 → 浅 → 深 → 跟随系统。 */
export function nextTheme(current: ThemeSource): ThemeSource {
  return SOURCES[(SOURCES.indexOf(current) + 1) % SOURCES.length]!
}

export const THEME_LABEL: Record<ThemeSource, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}
