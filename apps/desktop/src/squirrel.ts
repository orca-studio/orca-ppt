import { spawn } from 'node:child_process'
import { win32 } from 'node:path'

/**
 * Windows 的安装和自动更新用 Squirrel.Windows。它在安装、更新、卸载时各起一次应用,带上
 * `--squirrel-install` 这类参数,等应用做完自己的事退出(最多 15 秒)。这几次不能开窗口、
 * 不能起 server,只建/删开始菜单和桌面快捷方式,然后退出。
 *
 * 快捷方式交给 Squirrel 自己的 Update.exe(装在 exe 上一层目录),和 electron-squirrel-startup
 * 是同一个做法,只是不为这十几行引一个包。
 *
 * 返回 true 表示这次是 Squirrel 起的,调用方什么都别做;`quit` 在 Update.exe 做完后被调用。
 */
export function handleSquirrelEvent(
  quit: () => void,
  argv: readonly string[] = process.argv,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): boolean {
  if (platform !== 'win32') return false
  const update = (args: string[]) => {
    const child = spawn(win32.join(win32.dirname(execPath), '..', 'Update.exe'), args, {
      detached: true,
    })
    child.on('error', quit)
    child.on('close', quit)
  }
  const exe = win32.basename(execPath)
  switch (argv[1]) {
    case '--squirrel-install':
    case '--squirrel-updated':
      update([`--createShortcut=${exe}`])
      return true
    case '--squirrel-uninstall':
      update([`--removeShortcut=${exe}`])
      return true
    case '--squirrel-obsolete':
      quit()
      return true
    default:
      return false
  }
}

/**
 * 装完之后 Squirrel 带 `--squirrel-firstrun` 起第一次。这时它还拿着更新锁,马上去查更新会报错,
 * 所以这一次不查,下一次启动再说。
 */
export function isSquirrelFirstRun(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--squirrel-firstrun')
}
