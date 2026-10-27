import { lstat, mkdir, readlink, realpath, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * skill 的固定位置:一个链接,指向当前在用的那份 skill(npm 包里的、桌面版带的、仓里的)。
 *
 * 新建稿子按相对路径引它,助手的 skills 目录也链它。skill 真正的位置会变 —— npm 全局目录跟着
 * Node 版本走(fnm、nvm),Windows 桌面版每个版本装在 `app-<版本>` 下 —— 稿子和助手都不跟着变,
 * 变的只有这一根链接(见 docs/ARCHITECTURE.md「稿子引运行时走一个稳定路径」)。
 */
export function stableSkillPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.ORCA_PPT_STABLE_SKILL) return env.ORCA_PPT_STABLE_SKILL
  if (platform === 'win32')
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OrcaPPT', 'skill')
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'orca-ppt', 'skill')
}

/**
 * 让固定位置指向这份 skill,返回固定位置;已经指着它就什么都不做。`orca-ppt` 命令和桌面版启动时各调一次,
 * 两个都装就是最后启动的那个说了算。
 *
 * 那里是个真目录(不是链接)就不碰,返回 undefined —— 不删用户自己放的东西。建不了链接
 * (权限之类)也返回 undefined:调用方照旧用 skill 真正的位置,不因此起不来。
 */
export async function linkStableSkill(
  skillPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const stable = stableSkillPath(env)
  try {
    const target = await realpath(skillPath)
    const info = await lstat(stable).catch(() => undefined)
    if (info) {
      if (!info.isSymbolicLink()) return undefined
      const current = resolve(dirname(stable), await readlink(stable))
      if ((await realpath(current).catch(() => current)) === target) return stable
      await unlink(stable)
    }
    await mkdir(dirname(stable), { recursive: true })
    // Windows 上用目录联接:不要管理员,也不要开发者模式
    await symlink(target, stable, process.platform === 'win32' ? 'junction' : 'dir')
    return stable
  } catch {
    return undefined
  }
}
