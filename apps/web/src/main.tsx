import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { applyTheme, readTheme } from './theme.js'
import './styles.css'

declare global {
  interface Window {
    orca?: {
      serverPort?: number
      platform?: string
      /** 开发时通过 ORCA_PPT_DECK 指定,启动就打开这份稿子。 */
      initialDeck?: string
      /** 渲染层不碰文件系统 —— 壳弹目录选择器,只把路径交回来。 */
      pickDeck?: () => Promise<string | undefined>
      /** 截一张带上下文的锚裁切图,落在应用数据目录,返回绝对路径。 */
      captureAnchor?: (input: {
        guestId: number | undefined
        box: { x: number; y: number; w: number; h: number }
        viewport: { w: number; h: number }
      }) => Promise<string | undefined>
      /** 菜单里的动作。菜单只是另一个触发器,走的是同一条协议方法。 */
      onMenuAction?: (handler: (action: string) => void) => void
      /** 菜单里的启用状态和勾选,跟着界面走。 */
      setMenuState?: (state: {
        canPresent: boolean
        exporting?: boolean
        theme: string
      }) => Promise<void>
      /** 设主题。壳这一层也要设,否则原生菜单/对话框和界面对不上。 */
      setTheme?: (source: 'system' | 'light' | 'dark') => Promise<boolean>
      /** 全屏放映。稿子好不好只有放映能回答。 */
      present?: (input: { previewUrl: string; slide: number; script?: string }) => Promise<boolean>
      /** 关掉放映窗口。 */
      stopPresent?: () => Promise<boolean>
      /** 放映中开关自动播放。没在放映返回 false。 */
      presentAutoplay?: (on: boolean) => Promise<boolean>
      /** 放映窗口还在不在自动播放。没在放映返回 null。 */
      presentAutoplayRunning?: () => Promise<boolean | null>
      /** 壳弹保存对话框,只把路径交回来。 */
      pickPptxPath?: (input: {
        dir: string
        name: string
        readOnly?: boolean
      }) => Promise<string | undefined>
      /** 导出失败,壳弹一个对话框说原因。导成了不提示。 */
      pptxFailed?: (reason: string) => Promise<void>
      /** 用系统默认应用打开一个阶段产物。改产物用用户自己的编辑器。 */
      openFile?: (path: string) => Promise<string | undefined>
      /** 截整张画布 —— agent 靠它自己看一眼做出来的东西。 */
      contentBounds?: () => Promise<
        { x: number; y: number; width: number; height: number; zoom: number } | undefined
      >
      captureCanvas?: (input: { guestId: number | undefined }) => Promise<string | undefined>
    }
  }
}

// 桌面壳通过窄桥过端口;`pnpm dev` 直开浏览器时回落到约定端口。
const port = window.orca?.serverPort ?? Number(import.meta.env.VITE_ORCA_PORT ?? 7331)

// 标题栏是藏起来的(macOS hiddenInset),所以窗口靠分栏标题那条来拖动。
// 红绿灯按钮浮在左上角,第一栏的标题要给它让出位置 —— 这两件事都按平台来。
document.documentElement.dataset.platform = window.orca?.platform ?? 'web'

// 默认跟随系统。显式选过的会在这里被重新应用。
applyTheme(readTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App serverUrl={`ws://127.0.0.1:${port}`} />
  </StrictMode>,
)
