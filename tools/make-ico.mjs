// Windows 的应用图标(exe、安装包、任务栏):从 docs/brand/orca-app-icon.png 生成
// apps/desktop/assets/icon.ico,提交进仓库。Windows 的打包机上没有 sips,所以不在打包时现做;
// 换了图标就在 Mac 上重跑一次:node tools/make-ico.mjs
//
// 用品牌源图,不用 assets/icon.png:那份按 macOS 规范缩小留了边,在任务栏里会显得小一圈。
// ICO 里每个尺寸都直接存 PNG(Windows Vista 起支持),不转 BMP。
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'docs/brand/orca-app-icon.png')
const target = join(root, 'apps/desktop/assets/icon.ico')
const sizes = [16, 24, 32, 48, 64, 128, 256]

const work = await mkdtemp(join(tmpdir(), 'orca-ico-'))
try {
  const images = []
  for (const size of sizes) {
    const png = join(work, `${size}.png`)
    execFileSync('sips', ['-z', String(size), String(size), source, '--out', png], {
      stdio: 'ignore',
    })
    images.push({ size, data: await readFile(png) })
  }
  // ICONDIR(6 字节)+ 每张一条 ICONDIRENTRY(16 字节)+ 图像数据
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i
    // 宽高写 0 表示 256
    header.writeUInt8(size % 256, entry)
    header.writeUInt8(size % 256, entry + 1)
    header.writeUInt8(0, entry + 2)
    header.writeUInt8(0, entry + 3)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  await writeFile(target, Buffer.concat([header, ...images.map((image) => image.data)]))
  console.log('Wrote', target)
} finally {
  await rm(work, { recursive: true, force: true })
}
