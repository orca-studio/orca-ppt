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

// serve 托管的界面要带对启动 token 才连得上 server。没带、带的是上一次启动的(serve 重启过 token 就换了)、
// 或者 serve 根本没在跑,都直说,不留一张白页让人猜
const missingToken = host.kind === 'browser' && !host.token && !import.meta.env.DEV
const serverUrl = `ws://127.0.0.1:${port}`

const root = createRoot(document.getElementById('root')!)
const notice = (text: string) =>
  root.render(
    <StrictMode>
      <p className="boot-notice">{text}</p>
    </StrictMode>,
  )

if (missingToken) {
  notice('网址里缺少启动令牌,连不上 Orca PPT。请用 orca-ppt serve 打印的完整网址打开。')
} else if (host.kind === 'browser' && host.token && !(await reachable())) {
  notice(
    '连不上 Orca PPT:这个网址可能是上一次启动时的(serve 每次启动换一个令牌),或者 serve 没在跑。' +
      '跑一遍 orca-ppt serve --detach,用它打印的网址打开。',
  )
} else {
  root.render(
    <StrictMode>
      <App serverUrl={serverUrl} />
    </StrictMode>,
  )
}

/** 浏览器版先试连一次:令牌不对时 server 直接拒掉握手,界面会一直连不上、一片空白。 */
function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${serverUrl}/?token=${encodeURIComponent(host.token!)}`)
    const done = (ok: boolean) => {
      clearTimeout(timer)
      socket.onopen = socket.onerror = socket.onclose = null
      socket.close()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), 5000)
    socket.onopen = () => done(true)
    socket.onerror = socket.onclose = () => done(false)
  })
}
