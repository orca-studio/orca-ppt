import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * 浏览器版的稿子在另一个源,guest 脚本由稿子自己加载:server 托管稿子时在末尾加一行
 * `<script src="<界面的源>/guest.js">`(见 apps/server/src/preview-host.ts 的 injectGuest)。
 * 这里把那几份 guest 脚本拼成这一个文件:打包时放进 dist,开发时由 Vite 直接给。
 *
 * 检视、改字这些只在稿子被嵌在工作台里时才装;稿子单独打开(渲染器截图、导出)时只留
 * 动作表,不碰页面。动作表自己会判断要不要挂 postMessage(见 guest/bridge.guest.js)。
 */
function guestBundle(): Plugin {
  const read = (name: string) =>
    readFileSync(new URL(`./src/guest/${name}.guest.js`, import.meta.url), 'utf8')
  const source = () =>
    [
      'if (window.parent !== window) {',
      ...['inspect', 'autoplay', 'edit', 'canvas'].map((name) => `;${read(name)}`),
      '}',
      `;${read('bridge')}`,
    ].join('\n')
  return {
    name: 'orca-guest-bundle',
    configureServer(server) {
      server.middlewares.use('/guest.js', (_req, res) => {
        res.setHeader('content-type', 'text/javascript; charset=utf-8')
        res.setHeader('cache-control', 'no-cache')
        res.end(source())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'guest.js', source: source() })
    },
  }
}

export default defineConfig({
  plugins: [react(), guestBundle()],
  // Electron 用 file:// 加载打包产物,绝对路径会 404。
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
})
