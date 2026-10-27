import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Electron 用 file:// 加载打包产物,绝对路径会 404。
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  // 在浏览器里直接开 Vite 时,画布是 iframe,要和界面同源才摸得到稿子页面:
  // 稿子预览和素材交给 server(apps/web/src/canvas.tsx 的 sameOrigin 只取路径)。
  server: {
    proxy: {
      '/p/': `http://127.0.0.1:${process.env.VITE_ORCA_PORT ?? 6722}`,
      '/asset/': `http://127.0.0.1:${process.env.VITE_ORCA_PORT ?? 6722}`,
    },
  },
})
