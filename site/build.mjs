// 官网 ppt.orca-studio.ai 的构建:产品介绍页 + 同款样稿(能在线翻页、点卡片弹窗放映)。
//   node site/build.mjs            要 ffmpeg(大 PNG 转 JPEG)
// 卡片封面是同款自带的图(frontmatter 的 poster),不在这里录样片。
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
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL = resolve(HERE, '../skills/orca-ppt')
const OUT = join(HERE, 'dist')

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
    // 封面图(poster,相对配方目录),和 app 首页用的是同一张
    if (!meta.poster)
      throw new Error(
        `${id} 没有 poster:node skills/orca-ppt/scripts/render-poster.mjs recipes/${id}`,
      )
    const poster = resolve(root, id, meta.poster)
    if (relative(SKILL, poster).startsWith('..') || !existsSync(poster))
      throw new Error(`${id} 的 poster 不在 skill 里或文件不存在：${meta.poster}`)
    list.push({
      id,
      title: meta.title,
      mode: meta.mode ?? '汇报稿',
      summary: meta.summary ?? '',
      order: Number.isFinite(+meta.order) ? +meta.order : -Infinity,
      dir,
      // 线上地址:examples/ 里的样稿沿用老地址,配方目录里的放 /recipes/<id>/
      path: relative(SKILL, dir).split('/').join('/') + '/',
      poster,
      pages: (readFileSync(join(dir, 'index.html'), 'utf8').match(/<section[\s>]/g) || []).length,
    })
  }
  // 新上架的在前:order 是上架序号,大的在前,没写的排最后
  return list.sort((a, b) => b.order - a.order || a.id.localeCompare(b.id))
}

/** 把一份样稿目录拷到线上,改掉 node_modules 路径,大 PNG 转 JPEG,带上它引的 _assets。 */
function publishDeck(from, rel) {
  const to = join(OUT, rel)
  // 给 agent 读的 md 不上线(mp4 是以前录的样片,一样不要)
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

/** 封面拷到 media/<id>.jpg;老示例站的缩略图地址(skill 的 README 引着 examples/<name>/thumb.jpg)也用它顶上。 */
function poster(recipe) {
  mkdirSync(join(OUT, 'media'), { recursive: true })
  cpSync(recipe.poster, join(OUT, 'media', `${recipe.id}.jpg`))
  cpSync(recipe.poster, join(OUT, recipe.path, 'thumb.jpg'))
  // 封面换了浏览器要重新取:文件内容的指纹带在地址上
  const v = createHash('sha256').update(readFileSync(recipe.poster)).digest('hex').slice(0, 8)
  return `media/${recipe.id}.jpg?v=${v}`
}

/** 点卡片弹出放映窗口(main.js 接管);不跑脚本、或者按着 ⌘ 点,就是新标签页打开样稿。 */
function card(recipe, cover) {
  return `
        <li class="card">
          <a class="card-media" href="${recipe.path}" target="_blank" rel="noopener" data-play data-title="${esc(recipe.title)}" aria-label="放映「${esc(recipe.title)}」的样稿">
            <img src="${cover}" alt="" loading="lazy" />
            <span class="card-open">放映 ▶</span>
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

const covers = new Map(recipes.map((r) => [r.id, poster(r)]))
const cards = recipes.map((r) => card(r, covers.get(r.id))).join('')
const hero = recipes.find((r) => r.id === 'story-circle') ?? recipes[0]

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
    `<a class="hero-play" href="${hero.path}" target="_blank" rel="noopener" data-play data-title="${esc(hero.title)}" aria-label="放映「${esc(hero.title)}」的样稿"><img src="${covers.get(hero.id)}" alt="" /><span class="hero-play-btn">放映这一份 ▶</span></a>`,
  )
  .replace('<!--HERO_TITLE-->', esc(hero.title))
  .replace('<!--HERO_PATH-->', hero.path)
writeFileSync(join(OUT, 'index.html'), html)

console.log(`官网 → ${relative(process.cwd(), OUT)}:${recipes.length} 个同款`)
