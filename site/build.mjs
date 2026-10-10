// 官网 ppt.orca-studio.ai 的构建:产品介绍页 + 同款样稿(能在线翻页)+ 同款样片。
//   node site/build.mjs            只拷页面和样稿,样片用 site/.cache 里已有的(没有就不放)
//   node site/build.mjs --media    缺的样片现录(要本机装 Chrome 和 ffmpeg,部署时在 CI 里跑)
//
// 规范内容只在 skills/orca-ppt/ 里:同款列表读 recipes/*/RECIPE.md 的 frontmatter,
// 样稿就是 skill 里那份,这里不复制一份、不手写一份。
//
// 线上不能带 node_modules:稿子里引的 ../../node_modules/{reveal.js,gsap}/dist/… 抽到 /vendor/,
// 路径跟着改。照片存成 PNG 的转 JPEG(只改上线的这份,源文件不动)。
// 老地址 /examples/<name>/ 继续能打开:skill 的 README 和外面的链接都指着它。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL = resolve(HERE, '../skills/orca-ppt')
const OUT = join(HERE, 'dist')
const CACHE = join(HERE, '.cache')
const RECORD = process.argv.includes('--media')

const VENDOR = [
  ['node_modules/reveal.js/dist/reset.css', 'reset.css'],
  ['node_modules/reveal.js/dist/reveal.css', 'reveal.css'],
  ['node_modules/reveal.js/dist/reveal.js', 'reveal.js'],
  ['node_modules/gsap/dist/gsap.min.js', 'gsap.min.js'],
]
const PHOTO_MIN = 300 * 1024 // 比这个大的 PNG 当照片看,小的多半是图标、线稿,转了反而糊
// GA4 的 measurement ID 不是密钥,本来就明文出现在页面源码里。本地预览设 GA_ID= 关掉
const GA_ID = process.env.GA_ID ?? 'G-HY0E7GFPHH'

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  )

/** RECIPE.md 开头的 frontmatter。和 apps/server/src/recipes.ts 读的是同一组键。 */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const out = {}
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = /^([a-z]+):\s*(.*?)\s*(#.*)?$/.exec(line)
    if (kv) out[kv[1]] = kv[2]
  }
  return out
}

function readRecipes() {
  const root = join(SKILL, 'recipes')
  const list = []
  for (const id of readdirSync(root)) {
    const file = join(root, id, 'RECIPE.md')
    if (!existsSync(file)) continue
    const meta = frontmatter(readFileSync(file, 'utf8'))
    if (meta.id !== id || !meta.title) continue
    const dir = meta.sample ? resolve(root, id, meta.sample) : join(root, id)
    if (relative(SKILL, dir).startsWith('..')) throw new Error(`${id} 的 sample 出了 skill 目录`)
    if (!existsSync(join(dir, 'index.html'))) throw new Error(`${id} 没有样稿 ${dir}/index.html`)
    const range = /^(\d+)-(\d+)$/.exec(meta.preview ?? '')
    list.push({
      id,
      title: meta.title,
      mode: meta.mode ?? '汇报稿',
      summary: meta.summary ?? '',
      order: Number.isFinite(+meta.order) ? +meta.order : 999,
      dir,
      // 线上地址:examples/ 里的样稿沿用老地址,配方目录里的放 /recipes/<id>/
      path: relative(SKILL, dir).split('/').join('/') + '/',
      range: range ? { from: +range[1], to: +range[2] } : null,
      cover: Number.isFinite(+meta.cover) && meta.cover !== undefined ? +meta.cover : null,
      pages: (readFileSync(join(dir, 'index.html'), 'utf8').match(/<section[\s>]/g) || []).length,
    })
  }
  return list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** 把一份样稿目录拷到线上,改掉 node_modules 路径,大 PNG 转 JPEG,带上它引的 _assets。 */
function publishDeck(from, rel) {
  const to = join(OUT, rel)
  // 录好的 mp4 和给 agent 读的 md 不上线
  cpSync(from, to, { recursive: true, filter: (p) => !/\.(mp4|md)$/.test(p) })
  let html = readFileSync(join(to, 'index.html'), 'utf8')
    .replace(/\.\.\/\.\.\/node_modules\/reveal\.js\/dist\//g, '../../vendor/')
    .replace(/\.\.\/\.\.\/node_modules\/gsap\/dist\//g, '../../vendor/')
  for (const f of walk(to)) {
    if (!f.endsWith('.png') || statSync(f).size < PHOTO_MIN) continue
    const jpg = f.replace(/\.png$/, '.jpg')
    execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-q:v', '3', '-y', jpg])
    rmSync(f)
    html = html.split(relative(to, f)).join(relative(to, jpg))
  }
  writeFileSync(join(to, 'index.html'), html)
  // 整页视频的片源在 examples/_assets/ 下,被引到的才拷
  for (const m of html.matchAll(/(?:src|href)="\.\.\/(_assets\/[^"]+)"/g)) {
    const src = join(from, '..', m[1])
    const dst = join(to, '..', m[1])
    if (!existsSync(src)) throw new Error(`${rel} 引用了不存在的素材 ${m[1]}`)
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst)
  }
}

/** 样片的缓存键:样稿目录 + 运行时 + 录制参数。和 app 的样片缓存一个思路,内容变了才重录。 */
function mediaKey(recipe) {
  const hash = createHash('sha256')
  for (const base of [recipe.dir, join(SKILL, 'runtime')]) {
    for (const f of walk(base).sort()) {
      // 录好的视频和给 agent 读的说明不影响画面,不算进键
      if (/\.(mp4|md)$/.test(f)) continue
      hash.update(relative(SKILL, f)).update(readFileSync(f))
    }
  }
  hash.update(JSON.stringify({ range: recipe.range, cover: recipe.cover, v: 1 }))
  return hash.digest('hex').slice(0, 16)
}

/**
 * 录一份样片:整份稿子逐帧录,再按 preview 截出那几页。
 * 截法和应用里的录制器一致(apps/desktop/src/preview-recorder.ts):
 * 从中间页起时,起始页只停 0.6 秒,接着是后面几页的转场和停留;cover 是片段内的秒数。
 */
function recordMedia(recipe, key) {
  const work = join(tmpdir(), `orca-site-${recipe.id}-${process.pid}`)
  mkdirSync(work, { recursive: true })
  const full = join(work, 'full.mp4')
  const report = join(work, 'report.json')
  execFileSync(
    'node',
    [
      join(SKILL, 'scripts/capture.mjs'),
      join(recipe.dir, 'index.html'),
      '-o',
      full,
      '--json',
      report,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const { fps, frames, slides } = JSON.parse(readFileSync(report, 'utf8'))
  // 每页在整段里从第几帧开始(转场 + 停留)
  const starts = []
  let at = 0
  for (const s of slides) {
    starts.push(at)
    at +=
      Math.round((s.transitionMs / 1000) * fps) + Math.max(1, Math.round((s.holdMs / 1000) * fps))
  }
  let from = 0
  let to = frames
  if (recipe.range) {
    const a = recipe.range.from - 1
    const b = Math.min(recipe.range.to, slides.length) - 1
    from = a > 0 ? Math.max(starts[a], (starts[a + 1] ?? frames) - Math.round(0.6 * fps)) : 0
    to = starts[b + 1] ?? frames
  }
  const start = from / fps
  const length = (to - from) / fps
  const coverAt = Math.min(recipe.cover ?? length * 0.75, length - 0.05)
  const video = join(CACHE, `${recipe.id}-${key}.mp4`)
  const poster = join(CACHE, `${recipe.id}-${key}.jpg`)
  // H.264 + faststart:Safari 也能放,下载一部分就能开始播
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-ss',
    String(start),
    '-t',
    String(length),
    '-i',
    full,
    '-vf',
    'scale=1280:-2',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    video,
  ])
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-ss',
    String(start + coverAt),
    '-i',
    full,
    '-frames:v',
    '1',
    '-vf',
    'scale=1280:-2',
    '-q:v',
    '4',
    poster,
  ])
  rmSync(work, { recursive: true, force: true })
}

function media(recipe) {
  const key = mediaKey(recipe)
  const video = join(CACHE, `${recipe.id}-${key}.mp4`)
  if (!existsSync(video) && RECORD) {
    console.log(`录样片 ${recipe.id}…`)
    recordMedia(recipe, key)
  }
  if (!existsSync(video)) return null
  // 同一个同款只留最新一份,CI 的缓存不越攒越大
  for (const name of readdirSync(CACHE)) {
    if (name.startsWith(`${recipe.id}-`) && !name.startsWith(`${recipe.id}-${key}.`))
      rmSync(join(CACHE, name))
  }
  mkdirSync(join(OUT, 'media'), { recursive: true })
  cpSync(video, join(OUT, 'media', `${recipe.id}.mp4`))
  cpSync(video.replace(/\.mp4$/, '.jpg'), join(OUT, 'media', `${recipe.id}.jpg`))
  // 老示例站的缩略图地址(skill 的 README 引着 examples/<name>/thumb.jpg),用封面顶上
  cpSync(video.replace(/\.mp4$/, '.jpg'), join(OUT, recipe.path, 'thumb.jpg'))
  return { video: `media/${recipe.id}.mp4?v=${key}`, poster: `media/${recipe.id}.jpg?v=${key}` }
}

function card(recipe, files) {
  const thumb = files
    ? `<video muted loop playsinline preload="none" poster="${files.poster}" data-src="${files.video}"></video>`
    : `<span class="card-empty">${esc(recipe.title)}</span>`
  return `
        <li class="card">
          <a class="card-media" href="${recipe.path}" target="_blank" rel="noopener" aria-label="打开「${esc(recipe.title)}」的样稿">
            ${thumb}
            <span class="card-open">翻页看样稿 ↗</span>
          </a>
          <div class="card-body">
            <h3>${esc(recipe.title)}</h3>
            <p>${esc(recipe.summary)}</p>
            <span class="card-meta">${esc(recipe.mode)} · ${recipe.pages} 页</span>
          </div>
        </li>`
}

// ---------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })
cpSync(join(HERE, 'src'), OUT, { recursive: true })

mkdirSync(join(OUT, 'vendor'), { recursive: true })
for (const [from, to] of VENDOR) {
  const src = join(SKILL, from)
  if (!existsSync(src))
    throw new Error(`缺少 skills/orca-ppt/${from},先在 skills/orca-ppt 里跑 npm ci`)
  cpSync(src, join(OUT, 'vendor', to))
}
cpSync(join(SKILL, 'runtime'), join(OUT, 'runtime'), { recursive: true })

// 所有示例都上线(老地址不失效),同款的样稿不在 examples/ 里的另外放
for (const name of readdirSync(join(SKILL, 'examples'))) {
  if (name.startsWith('_') || !existsSync(join(SKILL, 'examples', name, 'index.html'))) continue
  publishDeck(join(SKILL, 'examples', name), `examples/${name}`)
}
const recipes = readRecipes()
for (const r of recipes) if (!r.path.startsWith('examples/')) publishDeck(r.dir, r.path)

const cards = recipes.map((r) => card(r, media(r))).join('')
const hero = recipes.find((r) => r.id === 'story-circle') ?? recipes[0]
const heroFiles = existsSync(join(OUT, 'media', `${hero.id}.mp4`))
  ? { video: `media/${hero.id}.mp4`, poster: `media/${hero.id}.jpg` }
  : null

const ga = GA_ID
  ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA_ID}');</script>`
  : ''
let html = readFileSync(join(OUT, 'index.html'), 'utf8')
  .replace('<!--GA-->', ga)
  .replace('<!--RECIPES-->', cards)
  .replace('<!--RECIPE_COUNT-->', String(recipes.length))
  .replace(
    '<!--HERO-->',
    heroFiles
      ? `<video autoplay muted loop playsinline poster="${heroFiles.poster}" src="${heroFiles.video}"></video>`
      : '',
  )
  .replace('<!--HERO_TITLE-->', esc(hero.title))
  .replace('<!--HERO_PATH-->', hero.path)
writeFileSync(join(OUT, 'index.html'), html)

const missing = recipes
  .filter((r) => !existsSync(join(OUT, 'media', `${r.id}.mp4`)))
  .map((r) => r.id)
console.log(
  `官网 → ${relative(process.cwd(), OUT)}:${recipes.length} 个同款` +
    (missing.length ? `,没有样片:${missing.join(' ')}(加 --media 现录)` : ''),
)
