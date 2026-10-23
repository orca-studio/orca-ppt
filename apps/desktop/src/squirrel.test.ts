import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.fn()
vi.mock('node:child_process', () => ({ spawn }))
const { handleSquirrelEvent, isSquirrelFirstRun } = await import('./squirrel.js')

const EXE = 'C:\\Users\\me\\AppData\\Local\\OrcaPPT\\app-0.1.14\\OrcaPPT.exe'
const UPDATE = 'C:\\Users\\me\\AppData\\Local\\OrcaPPT\\Update.exe'
const handle = (flag: string, quit = vi.fn(), platform: NodeJS.Platform = 'win32') =>
  handleSquirrelEvent(quit, [EXE, flag], platform, EXE)

describe('Squirrel 事件', () => {
  beforeEach(() => {
    spawn.mockReset().mockImplementation(() => new EventEmitter())
  })

  it('不是 Windows 就什么都不做', () => {
    expect(handle('--squirrel-install', vi.fn(), 'darwin')).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('普通启动不拦', () => {
    expect(handleSquirrelEvent(vi.fn(), [EXE], 'win32', EXE)).toBe(false)
  })

  it('安装和更新时让 Update.exe 建快捷方式,做完才退出', () => {
    for (const flag of ['--squirrel-install', '--squirrel-updated']) {
      const quit = vi.fn()
      expect(handle(flag, quit)).toBe(true)
      expect(spawn).toHaveBeenLastCalledWith(UPDATE, ['--createShortcut=OrcaPPT.exe'], {
        detached: true,
      })
      expect(quit).not.toHaveBeenCalled()
      ;(spawn.mock.results.at(-1)!.value as EventEmitter).emit('close', 0)
      expect(quit).toHaveBeenCalledOnce()
    }
  })

  it('卸载时删快捷方式', () => {
    expect(handle('--squirrel-uninstall')).toBe(true)
    expect(spawn).toHaveBeenCalledWith(UPDATE, ['--removeShortcut=OrcaPPT.exe'], {
      detached: true,
    })
  })

  it('Update.exe 起不来也要退出,不能卡住安装', () => {
    const quit = vi.fn()
    handle('--squirrel-install', quit)
    ;(spawn.mock.results[0]!.value as EventEmitter).emit('error', new Error('ENOENT'))
    expect(quit).toHaveBeenCalledOnce()
  })

  it('旧版本被替换时直接退出', () => {
    const quit = vi.fn()
    expect(handle('--squirrel-obsolete', quit)).toBe(true)
    expect(quit).toHaveBeenCalledOnce()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('装完第一次启动认得出来', () => {
    expect(isSquirrelFirstRun([EXE, '--squirrel-firstrun'])).toBe(true)
    expect(isSquirrelFirstRun([EXE])).toBe(false)
  })
})
