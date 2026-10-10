// 开发时把 Electron.app 的 bundle 名字和图标改成 Orca PPT 的。
//
// 为什么非得动 bundle:macOS 最左边那个应用菜单的标题取自 `CFBundleName`,
// `app.setName()` 和菜单模板里的 label 都改不动它 —— 不改就一直显示 "Electron"。
// 图标同理:macOS「关于」窗口和 Dock 用的是 bundle 里的 electron.icns,不换就一直是 Electron 的。
// 发布版由打包器按 productName 和图标生成自己的 bundle,不走这里。
//
// 只改 node_modules 里这一份,幂等,重装依赖后再跑一次即可。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NAME = 'Orca PPT'

if (process.platform !== 'darwin') process.exit(0)

const pnpmDir = 'node_modules/.pnpm'
const electron = existsSync(pnpmDir)
  ? readdirSync(pnpmDir).find((entry) => entry.startsWith('electron@'))
  : undefined
const plist = electron
  ? join(pnpmDir, electron, 'node_modules/electron/dist/Electron.app/Contents/Info.plist')
  : 'node_modules/electron/dist/Electron.app/Contents/Info.plist'

if (!existsSync(plist)) {
  // 还没装 Electron 二进制。不是错误,dev 会自己装。
  process.exit(0)
}

const read = (key) => {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return undefined
  }
}

const app = plist.replace('/Contents/Info.plist', '')
let changed = false

if (read('CFBundleName') !== NAME) {
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    const command = read(key) === undefined ? `Add :${key} string ${NAME}` : `Set :${key} ${NAME}`
    execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist])
  }
  changed = true
}

// 图标:从壳的 1024 图标生成 .icns 盖掉 electron.icns。按源图摘要判断要不要重做
const source = 'apps/desktop/assets/icon.png'
const stamp = join(app, 'Contents/Resources/.orca-icon')
const digest = createHash('sha256').update(readFileSync(source)).digest('hex')
if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== digest) {
  const work = mkdtempSync(join(tmpdir(), 'orca-dev-icon-'))
  const iconset = join(work, 'icon.iconset')
  execFileSync('mkdir', ['-p', iconset])
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = String(size * scale)
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      execFileSync('sips', ['-z', px, px, source, '--out', join(iconset, name)], {
        stdio: 'ignore',
      })
    }
  }
  execFileSync('iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    join(app, 'Contents/Resources/electron.icns'),
  ])
  rmSync(work, { recursive: true, force: true })
  writeFileSync(stamp, digest)
  changed = true
}

if (!changed) process.exit(0)

// 改过 bundle 之后 Launch Services 还缓存着旧名字和图标,签名也失效了 —— 重签一次临时签名,
// 再让 Finder / Dock 重新读一次图标
try {
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' })
} catch {
  // 签不上也能跑起来,只是名字可能要下次启动才刷新
}
try {
  execFileSync('touch', [app])
} catch {
  // 刷新不了就等下次启动
}

process.stdout.write(`开发用的 Electron 已改成 ${NAME} 的名字和图标\n`)
