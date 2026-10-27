import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * 打不带壳的 npm 包:`release/orca-ppt-<版本>.tgz`,另拷一份固定名字的 `release/orca-ppt.tgz`
 * (发版时传到 GitHub Release,llms.txt 指向 latest/download/orca-ppt.tgz)。
 *
 * 不发 npmjs:`npm install -g <tgz 地址>` 就能装,和 DMG 同一次发版、同一个版本号。
 *
 * 包的形状(apps/cli/src/main.ts 按这个认自己是不是装好的包):
 *
 *   package/
 *     package.json   bin: orca-ppt
 *     bin/orca-ppt.js   CLI + server 打成一个文件,运行时不再装依赖
 *     assets/           server 的图标(MCP 握手里给宿主的)
 *     web/              界面打包产物,serve 托管它
 *     skill/            skills/orca-ppt,连同它自己的 node_modules(reveal.js、GSAP、playwright-core)
 *
 * skill 的依赖必须在 skill/node_modules 里:稿子按相对路径引 `{{ROOT}}/node_modules/reveal.js/…`,
 * 交给 npm 去装会被提到包的顶层,稿子就找不到了。所以 tgz 自己打(tar),不用 npm pack ——
 * npm pack 会把 node_modules 剔掉。
 *
 * 先 `pnpm build`(界面要 apps/web/dist)。用法:node tools/pack-npm.mjs [输出目录,默认 release]
 * 另写 `SHA256SUMS-npm.txt`(带版本号的那份),发版时并进 Release 的 SHA256SUMS.txt。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stage = await mkdtemp(join(tmpdir(), 'orca-npm-'))
const pkg = join(stage, 'package')
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const isWindows = process.platform === 'win32'

try {
  const { version } = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
  await mkdir(join(pkg, 'skill'), { recursive: true })

  // skill 取当前提交里的那一份,不取工作区 —— 和桌面版安装包同一个做法(tools/package.mjs)
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()
  run('git', [
    'archive',
    '--format=tar',
    '--output=' + join(stage, 'skill.tar'),
    `${revision}:skills/orca-ppt`,
  ])
  run('tar', ['-xf', '../../skill.tar'], join(pkg, 'skill'))
  await readFile(join(pkg, 'skill/SKILL.md'))
  if (isWindows) {
    execFileSync('npm.cmd', ['ci', '--omit=dev', '--ignore-scripts'], {
      cwd: join(pkg, 'skill'),
      stdio: 'inherit',
      shell: true,
    })
  } else run('npm', ['ci', '--omit=dev', '--ignore-scripts'], join(pkg, 'skill'))
  await rm(join(pkg, 'skill/node_modules/.bin'), { recursive: true, force: true })
  await writeFile(
    join(pkg, 'skill/bundle-manifest.json'),
    JSON.stringify({ appVersion: version, revision }, null, 2),
  )

  await build({
    entryPoints: [join(root, 'apps/cli/src/main.ts')],
    outfile: join(pkg, 'bin/orca-ppt.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // ws 的两个可选加速包,不装也能跑
    external: ['bufferutil', 'utf-8-validate'],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  })
  await chmod(join(pkg, 'bin/orca-ppt.js'), 0o755)
  await cp(join(root, 'apps/server/assets'), join(pkg, 'assets'), { recursive: true })
  await cp(join(root, 'apps/web/dist'), join(pkg, 'web'), { recursive: true })
  await cp(join(root, 'LICENSE'), join(pkg, 'LICENSE'))
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify(
      {
        name: 'orca-ppt',
        version,
        description: '不开应用做会动的演示稿:CLI,和浏览器里的 Orca PPT 工作台(orca-ppt serve)',
        type: 'module',
        bin: { 'orca-ppt': 'bin/orca-ppt.js' },
        engines: { node: '>=22.18.0' },
        license: 'MIT',
        homepage: 'https://github.com/orca-studio/orca-ppt',
      },
      null,
      2,
    ) + '\n',
  )

  const release = resolve(root, process.argv[2] ?? 'release')
  await mkdir(release, { recursive: true })
  const name = `orca-ppt-${version}.tgz`
  const versioned = join(release, name)
  run('tar', ['-czf', versioned, 'package'], stage)
  // 不带版本号的那份:llms.txt 指向 releases/latest/download/orca-ppt.tgz,发新版不用改
  await cp(versioned, join(release, 'orca-ppt.tgz'))
  const sha = createHash('sha256')
    .update(await readFile(versioned))
    .digest('hex')
  await writeFile(join(release, 'SHA256SUMS-npm.txt'), `${sha}  ${name}\n`)
  console.log(`打好了:${versioned}(另拷一份 orca-ppt.tgz)`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
