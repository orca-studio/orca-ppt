import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { host, SERVER_PORT } from './host.js'
import { applyTheme, readTheme } from './theme.js'
import './styles.css'

// 桌面壳通过窄桥过端口;`pnpm dev` 直开浏览器时回落到约定端口。
const port = host.serverPort ?? Number(import.meta.env.VITE_ORCA_PORT ?? SERVER_PORT)

// 标题栏是藏起来的(macOS hiddenInset),所以窗口靠分栏标题那条来拖动。
// 红绿灯按钮浮在左上角,第一栏的标题要给它让出位置 —— 这两件事都按平台来。
document.documentElement.dataset.platform = host.platform ?? 'web'

// 默认跟随系统。显式选过的会在这里被重新应用。
applyTheme(readTheme())

// serve 托管的界面要带启动 token 才连得上 server。没带就直说,不留一张白页让人猜
const missingToken = host.kind === 'browser' && !host.token && !import.meta.env.DEV

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {missingToken ? (
      <p className="boot-notice">
        网址里缺少启动令牌,连不上 Orca PPT。请用 <code>orca-ppt serve</code> 打印的完整网址打开。
      </p>
    ) : (
      <App serverUrl={`ws://127.0.0.1:${port}`} />
    )}
  </StrictMode>,
)
