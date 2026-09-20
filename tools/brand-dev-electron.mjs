// 开发时把 Electron.app 的 bundle 名字改成 OrcaPPT。
//
// 为什么非得动 bundle:macOS 最左边那个应用菜单的标题取自 `CFBundleName`,
// `app.setName()` 和菜单模板里的 label 都改不动它 —— 不改就一直显示 "Electron"。
// 发布版由打包器按 productName 生成自己的 bundle,不走这里。
//
// 只改 node_modules 里这一份,幂等,重装依赖后再跑一次即可。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'OrcaPPT'

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

if (read('CFBundleName') === NAME) process.exit(0)

for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  const command = read(key) === undefined ? `Add :${key} string ${NAME}` : `Set :${key} ${NAME}`
  execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist])
}

// 改过 Info.plist 之后 Launch Services 还缓存着旧名字,签名也失效了 —— 重签一次临时签名。
try {
  execFileSync('codesign', ['--force', '--sign', '-', plist.replace('/Contents/Info.plist', '')], {
    stdio: 'ignore',
  })
} catch {
  // 签不上也能跑起来,只是名字可能要下次启动才刷新
}

process.stdout.write(`开发用的 Electron 菜单名已改成 ${NAME}\n`)
