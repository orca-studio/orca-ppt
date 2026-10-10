// 把首页和示例打包成一个自包含的静态站，可以直接丢上任何静态托管。
//   node scripts/build-site.mjs [输出目录]     默认 site/
//
// 和本地预览的区别：
//   稿子里引的是 ../../node_modules/{reveal.js,gsap}/dist/…，线上不能带 node_modules，
//   所以把那四个文件抽到 vendor/，并改写稿子里的路径。
//   mp4 不上传 —— 首页只用它生成缩略图，缩略图已经在 examples/<name>/thumb.jpg 里了。
//   大图转 JPEG —— 照片存成 PNG 是无损存摄影图，白白大十几倍。源文件不动，只改上线的这份。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, process.argv[2] || "site");

const VENDOR = [
  ["node_modules/reveal.js/dist/reset.css", "reset.css"],
  ["node_modules/reveal.js/dist/reveal.css", "reveal.css"],
  ["node_modules/reveal.js/dist/reveal.js", "reveal.js"],
  ["node_modules/gsap/dist/gsap.min.js", "gsap.min.js"],
];

// 先跑一遍首页生成（它同时会刷新各示例的 thumb.jpg）
// GA4 的 measurement ID 不是密钥 —— 它本来就明文出现在每个用 GA 的页面源码里。
// 构建（给线上用）默认带上，本地预览 npm run gallery 不设就不带。
const GA_ID = process.env.GA_ID ?? "G-HY0E7GFPHH";
execFileSync("node", [join(ROOT, "scripts/gallery.mjs")], { stdio: "inherit", env: { ...process.env, GA_ID } });

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "vendor"), { recursive: true });

for (const [from, to] of VENDOR) {
  const src = join(ROOT, from);
  if (!existsSync(src)) { console.error(`缺少 ${from}，先跑 npm install`); process.exit(1); }
  cpSync(src, join(OUT, "vendor", to));
}

cpSync(join(ROOT, "runtime"), join(OUT, "runtime"), { recursive: true });
cpSync(join(ROOT, "index.html"), join(OUT, "index.html"));

// 首页上列出来的示例才拷；mp4 一律不拷
const listed = new Set([...readFileSync(join(ROOT, "index.html"), "utf8")
  .matchAll(/href="examples\/([^/"]+)\//g)].map((m) => m[1]));

const PHOTO_MIN = 300 * 1024;   // 比这个大的 PNG 当照片看待，小的多半是图标 / 线稿，转了反而糊

const walk = (d) => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

for (const name of listed) {
  const from = join(ROOT, "examples", name);
  const to = join(OUT, "examples", name);
  cpSync(from, to, { recursive: true, filter: (p) => !p.endsWith("index.mp4") });

  let html = readFileSync(join(to, "index.html"), "utf8")
    .replace(/\.\.\/\.\.\/node_modules\/reveal\.js\/dist\//g, "../../vendor/")
    .replace(/\.\.\/\.\.\/node_modules\/gsap\/dist\//g, "../../vendor/");

  for (const f of walk(to)) {
    if (!f.endsWith(".png") || statSync(f).size < PHOTO_MIN) continue;
    const jpg = f.replace(/\.png$/, ".jpg");
    execFileSync("ffmpeg", ["-v", "error", "-i", f, "-q:v", "3", "-y", jpg]);
    rmSync(f);
    html = html.split(f.slice(to.length + 1)).join(jpg.slice(to.length + 1));
  }
  writeFileSync(join(to, "index.html"), html);
}

// 稿子引用 examples/_assets/ 下的素材时（整页视频的片源），把被引到的文件也拷过去
for (const name of listed) {
  const html = readFileSync(join(OUT, "examples", name, "index.html"), "utf8");
  for (const m of html.matchAll(/(?:src|href)="\.\.\/(_assets\/[^"]+)"/g)) {
    const rel = m[1];
    const src = join(ROOT, "examples", rel);
    if (!existsSync(src)) { console.error(`${name} 引用了不存在的素材：examples/${rel}`); process.exit(1); }
    const dst = join(OUT, "examples", rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
}

const size = (d) => readdirSync(d, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
console.log(`\n${OUT}  ${listed.size} 份示例，${(size(OUT) / 1048576).toFixed(1)} MB`);
console.log("剩下的 node_modules 引用（应为 0）：",
  [...listed].filter((n) => readFileSync(join(OUT, "examples", n, "index.html"), "utf8").includes("node_modules")).join(" ") || "0");
