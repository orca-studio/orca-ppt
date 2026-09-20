import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Electron 用 file:// 加载打包产物,绝对路径会 404。
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
})
