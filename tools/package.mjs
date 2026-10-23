import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { packager } from '@electron/packager'
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stage = await mkdtemp(join(tmpdir(), 'orca-package-'))
const app = join(stage, 'app'),
  skill = join(stage, 'skill')
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const isWindows = process.platform === 'win32'
try {
  await mkdir(skill, { recursive: true })
  // skill 在本仓的 skills/orca-ppt/ 里:取当前提交里的那一份,不取工作区 —— 改了没提交的不进安装包。
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()
  run('git', [
    'archive',
    '--format=tar',
    '--output=' + join(stage, 'skill.tar'),
    `${revision}:skills/orca-ppt`,
  ])
  // 相对路径解包:Windows 的 CI 上 PATH 里先找到的是 Git 带的 GNU tar,它把 `C:\…` 里的冒号当成远程主机
  run('tar', ['-xf', '../skill.tar'], skill)
  await readFile(join(skill, 'SKILL.md'))
  // Windows 上 npm 是 npm.cmd,Node 只肯通过 shell 起 .cmd
  if (isWindows) {
    execFileSync('npm.cmd', ['ci', '--omit=dev', '--ignore-scripts'], {
      cwd: skill,
      stdio: 'inherit',
      shell: true,
    })
  } else run('npm', ['ci', '--omit=dev', '--ignore-scripts'], skill)
  // npm 给命令行工具生成的快捷方式(.bin)运行时用不到;里面有指向不存在文件的链接,
  // codesign --strict 校验会因此失败
  await rm(join(skill, 'node_modules/.bin'), { recursive: true, force: true })
  const metadata = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
  await writeFile(
    join(skill, 'bundle-manifest.json'),
    JSON.stringify({ appVersion: metadata.version, revision }, null, 2),
  )
  await mkdir(app, { recursive: true })
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'orca-ppt',
      version: metadata.version,
      type: 'module',
      main: 'apps/desktop/dist/main.js',
    }),
  )
  for (const part of ['desktop', 'server']) {
    await build({
      entryPoints: [join(root, `apps/${part}/src/main.ts`)],
      outfile: join(app, `apps/${part}/dist/main.js`),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['electron', 'bufferutil', 'utf-8-validate'],
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
    })
    await cp(join(root, `apps/${part}/assets`), join(app, `apps/${part}/assets`), {
      recursive: true,
    })
  }
  await cp(join(root, 'apps/desktop/dist/preload.cjs'), join(app, 'apps/desktop/dist/preload.cjs'))
  await cp(join(root, 'apps/web/dist'), join(app, 'apps/web/dist'), { recursive: true })
  const buildNumber = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root })
    .toString()
    .trim()
  const electron = JSON.parse(
    await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'),
  )
  // Windows 的 .ico 是提交进仓库的(tools/make-ico.mjs 生成),打包机上没有 sips
  const icon = isWindows ? join(root, 'apps/desktop/assets/icon.ico') : await macIcon()
  const output = await packager({
    dir: app,
    out: join(root, 'release'),
    name: 'Orca PPT',
    // 和 Compositor 同一套命名(ai.orca-studio.compositor)。发版之后不能再改,自动更新认它
    appBundleId: 'ai.orca-studio.ppt',
    appCategoryType: 'public.app-category.productivity',
    icon,
    // Windows 上 exe 不带空格:Squirrel 按它建快捷方式、认进程。显示名照样是 Orca PPT
    ...(isWindows && { executableName: 'OrcaPPT' }),
    win32metadata: {
      CompanyName: 'Orca Studio',
      FileDescription: 'Orca PPT',
      ProductName: 'Orca PPT',
      InternalName: 'OrcaPPT',
      OriginalFilename: 'OrcaPPT.exe',
    },
    appVersion: metadata.version,
    // 构建号(「关于」里括号里那个):提交总数,每次发版自然递增,不用手动维护。
    // Windows 上它是 exe 的 FileVersion,要四段数字,所以前面拼上版本号
    buildVersion: (isWindows ? `${metadata.version}.` : '') + buildNumber,
    electronVersion: electron.version,
    platform: process.platform,
    arch: process.arch,
    asar: false,
    prune: false,
    overwrite: true,
    extraResource: [skill],
  })
  // 签名之前关掉几个能被拿来往应用里注入代码的入口(改开关会改可执行文件,必须在签名前)。
  // server 用 utilityProcess 起,不需要 RunAsNode;界面走 file://,file 协议的开关保持默认。
  for (const dir of output) {
    await flipFuses(join(dir, isWindows ? 'OrcaPPT.exe' : 'Orca PPT.app'), {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: process.platform === 'darwin' && process.arch === 'arm64',
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
    })
  }
  console.log('Packaged:', output.join('\n'))
} finally {
  await rm(stage, { recursive: true, force: true })
}

/** Finder / Dock 里的应用图标:从壳的 1024 图标(已按 macOS 规范留边、加投影)生成 .icns */
async function macIcon() {
  const iconset = join(stage, 'icon.iconset')
  await mkdir(iconset, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = String(size * scale)
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      run('sips', [
        '-z',
        px,
        px,
        join(root, 'apps/desktop/assets/icon.png'),
        '--out',
        join(iconset, name),
      ])
    }
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', join(stage, 'icon.icns')])
  return join(stage, 'icon.icns')
}
