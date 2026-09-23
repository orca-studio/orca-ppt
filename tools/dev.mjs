import { spawn } from 'node:child_process'

/**
 * 开发时三个进程:server、Vite、Electron。server 由 Electron 壳自己拉起(和发布版
 * 同一条路径,避免开发和发布两套启动逻辑),这里只管 Vite 和 Electron。
 */
const PORT = process.env.ORCA_PPT_DEV_PORT ?? '5273'

const children = []
function run(command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...env },
  })
  children.push(child)
  child.on('exit', (code) => {
    if (code !== 0) stop(code ?? 1)
  })
  return child
}

function stop(code = 0) {
  for (const child of children) child.kill()
  process.exit(code)
}

process.on('SIGINT', () => stop(0))

// 显式绑 IPv4:Vite 默认听 localhost,在新版 macOS 上只落到 [::1],而壳加载的是
// 127.0.0.1 —— 连不上,窗口一片黑,画布和截图全都不工作。
run('pnpm', [
  '--filter',
  '@orca-ppt/web',
  'dev',
  '--port',
  PORT,
  '--strictPort',
  '--host',
  '127.0.0.1',
])
run('pnpm', ['-r', '--filter', '!@orca-ppt/web', 'build']).on('exit', () => {
  run('pnpm', ['--filter', '@orca-ppt/desktop', 'start'], {
    ORCA_PPT_DEV_SERVER: `http://127.0.0.1:${PORT}`,
  })
})
