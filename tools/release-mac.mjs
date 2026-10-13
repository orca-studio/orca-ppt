// macOS 发布:打包 → Developer ID 签名 → zip + dmg → 提交公证(不等) → 之后再查结果、staple。
// 结构照 Compositor 的 scripts/ci_release.sh:提交和查询分成两次,不让任何地方干等 Apple。
//
//   node tools/release-mac.mjs build      打包、签名、做 zip 和 dmg、提交公证,写 dist/release/release.json
//   node tools/release-mac.mjs finalize   查一次公证结果;通过就 staple 应用、用它重做 dmg 再公证(等结果)、
//                                         staple dmg、做 Gatekeeper 检查、写 SHA256SUMS.txt。要签名身份
//
// 环境变量:
//   APPLE_TEAM_ID                     必填。签名身份按它从钥匙串里挑(Developer ID Application: … (TEAM))
//   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD   公证凭据;或者 NOTARY_PROFILE(notarytool store-credentials 存的名字)
//   SKIP_NOTARIZE=1                   本机只验签名和 dmg,不提交 Apple
//
// 产物都在 dist/release/:
//   OrcaPPT-<版本>-<arch>.dmg          给第一次安装的人
//   OrcaPPT-darwin-<arch>-<版本>.zip   给自动更新(update.electronjs.org 按文件名认平台和架构)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist/release')
const mode = process.argv[2]
const arch = process.arch
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim()
const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const sha256 = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

const team = process.env.APPLE_TEAM_ID ?? ''
if (!/^[A-Z0-9]{10}$/.test(team)) fail('APPLE_TEAM_ID 没设或格式不对')

function notaryAuth() {
  if (process.env.NOTARY_PROFILE) return ['--keychain-profile', process.env.NOTARY_PROFILE]
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD } = process.env
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD) {
    fail('缺公证凭据:设 APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD,或者 NOTARY_PROFILE')
  }
  return ['--apple-id', APPLE_ID, '--team-id', team, '--password', APPLE_APP_SPECIFIC_PASSWORD]
}

/** 钥匙串里属于这个团队的那一个 Developer ID Application 身份。不是正好一个就停。 */
function signingIdentity() {
  const lines = read('security', ['find-identity', '-v', '-p', 'codesigning'])
    .split('\n')
    .map((line) => line.match(/"(Developer ID Application: .+ \(([A-Z0-9]{10})\))"/))
    .filter((m) => m && m[2] === team)
  const names = [...new Set(lines.map((m) => m[1]))]
  if (names.length !== 1)
    fail(`要正好一个属于 ${team} 的 Developer ID Application 身份,找到 ${names.length} 个`)
  return names[0]
}

/** dmg:应用 + 一个指向 /Applications 的快捷方式,拖进去就装好了。签名。 */
async function makeDmg(app, dmg, identity) {
  const staging = join(tmpdir(), `orca-dmg-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  await rm(dmg, { force: true })
  await mkdir(staging, { recursive: true })
  await cp(app, join(staging, 'Orca PPT.app'), { recursive: true, verbatimSymlinks: true })
  await symlink('/Applications', join(staging, 'Applications'))
  run('hdiutil', [
    'create',
    '-quiet',
    '-volname',
    'Orca PPT',
    '-srcfolder',
    staging,
    '-format',
    'UDZO',
    dmg,
  ])
  await rm(staging, { recursive: true, force: true })
  run('codesign', ['--sign', identity, '--timestamp', dmg])
}

async function build() {
  const pkg = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
  const version = pkg.version
  if (!/^\d+\.\d+\.\d+$/.test(version))
    fail(`apps/desktop/package.json 的 version 要是 x.y.z:${version}`)
  // 打 tag 发版时,tag 必须和版本一致;本机试打不要求
  const tag = process.env.SOURCE_TAG
  if (tag && tag !== `v${version}`) fail(`tag ${tag} 和应用版本 v${version} 对不上`)

  const identity = signingIdentity()
  // 只有 build 用得到签名库:finalize 在 CI 里不装依赖,只要 Node 就能跑
  const { sign } = await import('@electron/osx-sign')
  run('pnpm', ['package'])
  const app = join(root, `release/Orca PPT-darwin-${arch}/Orca PPT.app`)
  if (!existsSync(app)) fail(`没找到打包产物:${app}`)

  // 签名:每一层(Helper、Framework)都签,开 Hardened Runtime,带时间戳
  const entitlements = join(root, 'apps/desktop/build/entitlements.mac.plist')
  await sign({
    app,
    identity,
    platform: 'darwin',
    optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
  })
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  // codesign -dv 把信息写在 stderr
  const detail = read('sh', ['-c', `codesign -dv --verbose=4 "${app}" 2>&1`])
  for (const [needle, what] of [
    [`TeamIdentifier=${team}`, '团队'],
    ['runtime', 'Hardened Runtime'],
    ['Timestamp=', '时间戳'],
  ]) {
    if (!detail.includes(needle)) fail(`签名缺${what}`)
  }

  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  const dmg = join(out, `OrcaPPT-${version}-${arch}.dmg`)
  const zip = join(out, `OrcaPPT-darwin-${arch}-${version}.zip`)

  // zip:给自动更新。ditto 保留符号链接和扩展属性,Framework 不会被拆坏
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])

  await makeDmg(app, dmg, identity)

  const meta = {
    schema_version: 1,
    version,
    tag: tag ?? null,
    commit: read('git', ['rev-parse', 'HEAD']),
    team_id: team,
    arch,
    dmg: { name: dmg.split('/').pop(), sha256: await sha256(dmg) },
    zip: { name: zip.split('/').pop(), sha256: await sha256(zip) },
    submission_id: null,
  }

  // 一次提交覆盖 dmg 和里面的应用;不等结果,之后用 finalize 查
  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('SKIP_NOTARIZE=1:只验签名和 dmg,不提交 Apple')
  } else {
    const submitted = JSON.parse(
      read('xcrun', ['notarytool', 'submit', dmg, ...notaryAuth(), '--output-format', 'json']),
    )
    if (!/^[0-9a-f-]{36}$/i.test(submitted.id ?? '')) fail('公证提交没返回 submission id')
    meta.submission_id = submitted.id
    console.log(`已提交公证:${submitted.id}。稍后运行 finalize 查结果。`)
  }
  await writeFile(join(out, 'release.json'), JSON.stringify(meta, null, 2) + '\n')
}

/** 挂上 dmg,确认里面的应用钉了票据(断网第一次打开靠它)。 */
async function checkAppInDmg(dmg) {
  const mount = join(tmpdir(), `orca-dmg-mount-${process.pid}`)
  await mkdir(mount, { recursive: true })
  run('hdiutil', ['attach', '-quiet', '-nobrowse', '-readonly', '-mountpoint', mount, dmg])
  try {
    run('xcrun', ['stapler', 'validate', join(mount, 'Orca PPT.app')])
  } finally {
    run('hdiutil', ['detach', '-quiet', mount])
  }
}

async function finalize() {
  const meta = JSON.parse(await readFile(join(out, 'release.json'), 'utf8'))
  if (meta.team_id !== team) fail('提交之后 Apple 团队变了')
  if (!meta.submission_id) fail('release.json 里没有 submission id(build 时跳过了公证?)')
  const dmg = join(out, meta.dmg.name)
  const zip = join(out, meta.zip.name)
  for (const [file, item] of [
    [dmg, meta.dmg],
    [zip, meta.zip],
  ]) {
    if ((await sha256(file)) !== item.sha256) fail(`${item.name} 和提交时不是同一个文件`)
  }

  const status = JSON.parse(
    read('xcrun', [
      'notarytool',
      'info',
      meta.submission_id,
      ...notaryAuth(),
      '--output-format',
      'json',
    ]),
  ).status
  if (status === 'In Progress') {
    console.log('Apple 还在处理,这次先结束。过一会儿再运行 finalize。')
    process.exitCode = 0
    await writeFile(join(out, 'notarization-status.txt'), 'in-progress\n')
    return
  }
  if (status !== 'Accepted') {
    run('xcrun', ['notarytool', 'log', meta.submission_id, ...notaryAuth()])
    fail(`公证没通过:${status}`)
  }

  // 提交的 dmg 通过了,票据覆盖里面的应用。先把应用 staple 好:zip 里的那份解开、staple、按原样再打包
  const work = join(tmpdir(), `orca-zip-${process.pid}`)
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  run('ditto', ['-x', '-k', zip, work])
  const app = join(work, 'Orca PPT.app')
  await stapleWhenReady(app)
  run('spctl', ['--assess', '--type', 'execute', '--verbose', app])
  await rm(zip)
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])

  // dmg 用 staple 过的应用重做一份:提交的那份里应用没钉票据,拖进 Applications 后
  // 第一次打开要联网问 Apple,断网就打不开。重做的 dmg 是新文件,要再公证一次 ——
  // 里面的应用 Apple 已经认过,这次通常几分钟,所以这里等它。
  await makeDmg(app, dmg, signingIdentity())
  await rm(work, { recursive: true, force: true })
  // 没通过或超时 notarytool 会以非零退出,结果仍在 stdout 上
  let again
  try {
    again = JSON.parse(
      read('xcrun', [
        'notarytool',
        'submit',
        dmg,
        ...notaryAuth(),
        '--wait',
        '--timeout',
        '20m',
        '--output-format',
        'json',
      ]),
    )
  } catch (error) {
    again = JSON.parse(String(error.stdout || '{}'))
  }
  if (again.status !== 'Accepted') {
    if (again.id) run('xcrun', ['notarytool', 'log', again.id, ...notaryAuth()])
    fail(`重做的 dmg 公证没通过:${again.status}`)
  }
  meta.dmg_submission_id = again.id
  await stapleWhenReady(dmg)
  run('xcrun', ['stapler', 'validate', dmg])
  run('spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose',
    dmg,
  ])
  await checkAppInDmg(dmg)

  meta.dmg.sha256 = await sha256(dmg)
  meta.zip.sha256 = await sha256(zip)
  meta.notarized = true
  await writeFile(join(out, 'release.json'), JSON.stringify(meta, null, 2) + '\n')
  await writeFile(
    join(out, 'SHA256SUMS.txt'),
    `${meta.dmg.sha256}  ${meta.dmg.name}\n${meta.zip.sha256}  ${meta.zip.name}\n`,
  )
  await writeFile(join(out, 'notarization-status.txt'), 'accepted\n')
  console.log(`公证通过,已 staple:${meta.dmg.name}、${meta.zip.name}`)
}

/**
 * stapler 要去 Apple 的查询服务(CloudKit)取票据,从 GitHub 的 runner 上经常连不稳:
 * 报「network connection was lost」、退出码 68。0.1.3 卡在 dmg 那一步两次,0.1.4 卡在
 * 应用那一步一次。应用和 dmg 都走这里,失败了隔一会儿再试。
 */
async function stapleWhenReady(path, attempts = 8, waitMs = 30_000) {
  for (let i = 1; ; i++) {
    try {
      run('xcrun', ['stapler', 'staple', path])
      return
    } catch (error) {
      if (i >= attempts) throw error
      console.log(`staple 第 ${i} 次没成(票据可能还没同步),${waitMs / 1000} 秒后再试`)
      await new Promise((done) => setTimeout(done, waitMs))
    }
  }
}

if (mode === 'build') await build()
else if (mode === 'finalize') await finalize()
else fail('用法:node tools/release-mac.mjs build | finalize')
