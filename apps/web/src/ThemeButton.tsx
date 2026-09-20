import { useState } from 'react'
import { applyTheme, nextTheme, readTheme, THEME_LABEL, type ThemeSource } from './theme.js'

/** 主题在哪个界面都有意义,所以独立出来给顶栏和选择器共用。 */
export function ThemeButton() {
  const [theme, setTheme] = useState<ThemeSource>(readTheme)

  return (
    <button
      type="button"
      title={`主题:${THEME_LABEL[theme]}`}
      onClick={() => {
        const next = nextTheme(theme)
        applyTheme(next)
        setTheme(next)
      }}
    >
      {THEME_LABEL[theme]}
    </button>
  )
}
