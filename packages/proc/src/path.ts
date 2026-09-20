import { accessSync, constants } from 'node:fs'
import { homedir, platform } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * GUI 启动的 Electron 不继承登录 shell,所以 PATH 里往往没有用户装 CLI 的地方。
 * 我们补上常规位置,而不是去 source `.zshrc` —— 执行用户的 rc 文件会把任意启动代码
 * 拉进我们的进程,而且在不同 shell 之间永远修不完。
 */
export function desktopSafePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir()
  const extras =
    platform() === 'win32'
      ? [join(home, 'AppData', 'Local', 'Programs')]
      : [
          join(home, '.local', 'bin'),
          join(home, '.bun', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
        ]

  const seen = new Set<string>()
  const parts = [...(env.PATH ?? '').split(delimiter), ...extras]
  return parts.filter((p) => p && !seen.has(p) && seen.add(p)).join(delimiter)
}

/** 在桌面安全 PATH 上找可执行文件。找不到返回 undefined —— 调用方据此把引擎标成不可用。 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const exts = platform() === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of desktopSafePath(env).split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // 下一个候选
      }
    }
  }
  return undefined
}
