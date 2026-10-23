// Windows 发布:打包 → Squirrel.Windows 安装包(Setup.exe + RELEASES + .nupkg)→ 写摘要。
// 只能在 Windows 上跑(Squirrel 的工具是 .NET 程序,别的平台要 wine + mono,不折腾)。
//
//   node tools/release-win.mjs
//
// 环境变量:
//   SOURCE_TAG                 可选。打 tag 发版时核对和应用版本一致
//   WINDOWS_SIGN_WITH_PARAMS   可选。交给 signtool 的参数,设了就给 Setup.exe 和里面每个 exe 签名;
//                              没设就出未签名的安装包(SmartScreen 会拦一道,点「仍要运行」能装)
//
// 产物都在 dist/release/(见 docs/RELEASE.md):
//   OrcaPPT-win32-x64-<版本>-Setup.exe   给第一次安装的人;文件名里的 -win32-x64 是给
//                                        update.electronjs.org 认平台的
//   RELEASES、OrcaPPT-<版本>-full.nupkg  给自动更新(Squirrel 读 RELEASES,再下 nupkg)
//   release-win.json、SHA256SUMS-win.txt  发布工作流用;和 macOS 的产物放在同一个目录里不撞名
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist/release')
const arch = process.arch
const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const sha256 = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

if (process.platform !== 'win32') fail('只能在 Windows 上跑')
if (arch !== 'x64') fail(`目前只出 x64 的安装包,这台是 ${arch}`)

const pkg = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
const version = pkg.version
if (!/^\d+\.\d+\.\d+$/.test(version))
  fail(`apps/desktop/package.json 的 version 要是 x.y.z:${version}`)
const tag = process.env.SOURCE_TAG
if (tag && tag !== `v${version}`) fail(`tag ${tag} 和应用版本 v${version} 对不上`)

// pnpm 在 Windows 上是 pnpm.cmd,Node 只肯通过 shell 起 .cmd
execFileSync('pnpm.cmd', ['package'], { cwd: root, stdio: 'inherit', shell: true })
const appDirectory = join(root, `release/Orca PPT-win32-${arch}`)
if (!existsSync(join(appDirectory, 'OrcaPPT.exe'))) fail(`没找到打包产物:${appDirectory}`)

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const signWithParams = process.env.WINDOWS_SIGN_WITH_PARAMS
if (!signWithParams) console.log('没设 WINDOWS_SIGN_WITH_PARAMS:出的是未签名的安装包')
const { createWindowsInstaller } = await import('electron-winstaller')
await createWindowsInstaller({
  appDirectory,
  outputDirectory: out,
  // Squirrel 的应用 ID:装到 %LOCALAPPDATA%\OrcaPPT,自动更新认它。发过版之后不能改
  name: 'OrcaPPT',
  title: 'Orca PPT',
  exe: 'OrcaPPT.exe',
  version,
  authors: 'Orca Studio',
  description: 'Orca PPT',
  setupIcon: join(root, 'apps/desktop/assets/icon.ico'),
  // 「应用和功能」里显示的图标,Squirrel 只收网址
  iconUrl:
    'https://raw.githubusercontent.com/orca-studio/orca-ppt/main/apps/desktop/assets/icon.ico',
  noMsi: true,
  ...(signWithParams && { signWithParams }),
})

const setup = `OrcaPPT-win32-${arch}-${version}-Setup.exe`
await rename(join(out, 'Setup.exe'), join(out, setup))
const nupkg = (await readdir(out)).find((name) => name.endsWith('-full.nupkg'))
if (!nupkg) fail('Squirrel 没产出 full.nupkg')
const releases = await readFile(join(out, 'RELEASES'), 'utf8')
if (!releases.includes(nupkg)) fail(`RELEASES 里没有 ${nupkg}`)

const files = [setup, 'RELEASES', nupkg]
const sums = await Promise.all(files.map(async (name) => [name, await sha256(join(out, name))]))
await writeFile(
  join(out, 'release-win.json'),
  JSON.stringify(
    {
      schema_version: 1,
      version,
      tag: tag ?? null,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      arch,
      signed: Boolean(signWithParams),
      setup,
      nupkg,
    },
    null,
    2,
  ) + '\n',
)
await writeFile(
  join(out, 'SHA256SUMS-win.txt'),
  sums.map(([name, hash]) => `${hash}  ${name}\n`).join(''),
)
console.log(`做好了:${files.join('、')}${signWithParams ? '' : '(未签名)'}`)
