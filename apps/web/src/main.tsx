import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

declare global {
  interface Window {
    orca?: {
      serverPort?: number
      platform?: string
      /** 开发时通过 ORCA_PPTCODE_DECK 指定,启动就打开这份稿子。 */
      initialDeck?: string
      /** 渲染层不碰文件系统 —— 壳弹目录选择器,只把路径交回来。 */
      pickDeck?: () => Promise<string | undefined>
      /** 截一张带上下文的锚裁切图,落在应用数据目录,返回绝对路径。 */
      captureAnchor?: (input: {
        guestId: number | undefined
        box: { x: number; y: number; w: number; h: number }
        viewport: { w: number; h: number }
      }) => Promise<string | undefined>
      /** 用系统默认应用打开一个阶段产物。改产物用用户自己的编辑器。 */
      openFile?: (path: string) => Promise<string | undefined>
      /** 截整张画布 —— agent 靠它自己看一眼做出来的东西。 */
      captureCanvas?: (input: { guestId: number | undefined }) => Promise<string | undefined>
    }
  }
}

// 桌面壳通过窄桥过端口;`pnpm dev` 直开浏览器时回落到约定端口。
const port = window.orca?.serverPort ?? Number(import.meta.env.VITE_ORCA_PORT ?? 7331)

// 标题栏是藏起来的(macOS hiddenInset),所以窗口靠分栏标题那条来拖动。
// 红绿灯按钮浮在左上角,第一栏的标题要给它让出位置 —— 这两件事都按平台来。
document.documentElement.dataset.platform = window.orca?.platform ?? 'web'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App serverUrl={`ws://127.0.0.1:${port}`} />
  </StrictMode>,
)
