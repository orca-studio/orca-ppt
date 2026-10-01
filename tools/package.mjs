import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { packager } from '@electron/packager'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await readFile(join(root, 'tools/skill-lock.json'), 'utf8'))
const source =
  process.env.ORCA_PPT_SKILL_SOURCE || join(homedir(), 'ghq/github.com/zhenwusw/orca-ppt-skill')
const stage = await mkdtemp(join(tmpdir(), 'orca-package-'))
const app = join(stage, 'app'),
  skill = join(stage, 'skill')
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
try {
  await mkdir(skill, { recursive: true })
  // Archive the pinned commit, never the developer's modified working tree.
  run(
    'git',
    ['archive', '--format=tar', '--output=' + join(stage, 'skill.tar'), lock.revision],
    source,
  )
  run('tar', ['-xf', join(stage, 'skill.tar'), '-C', skill])
  await readFile(join(skill, 'SKILL.md'))
  run('npm', ['ci', '--omit=dev', '--ignore-scripts'], skill)
  const metadata = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
  await writeFile(
    join(skill, 'bundle-manifest.json'),
    JSON.stringify({ appVersion: metadata.version, ...lock }, null, 2),
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
  const electron = JSON.parse(
    await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'),
  )
  const output = await packager({
    dir: app,
    out: join(root, 'release'),
    name: 'OrcaPPT',
    appBundleId: 'studio.orca.ppt',
    appVersion: metadata.version,
    electronVersion: electron.version,
    platform: process.platform,
    arch: process.arch,
    asar: false,
    prune: false,
    overwrite: true,
    extraResource: [skill],
  })
  console.log('Packaged:', output.join('\n'))
} finally {
  await rm(stage, { recursive: true, force: true })
}
