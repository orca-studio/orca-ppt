// 把现成的 .pptx 整理成内容大纲，给 agent 当素材、重新做成网页稿。PPTX 在这里只是素材：版式会重新
// 设计，要的是内容取全 —— 每页的文字（分段、层级、字号字重颜色）、图片、表格、图表数据和备注。
//
//   node scripts/extract-pptx.mjs <deck.pptx> [-o 目录] [--json] [--frames]
//
// 写进目录（默认是 pptx 同名加 -extract）：
//   outline.md    大纲：按页列出每块内容和它在画布上的位置（页宽按 1920 换算）
//   media/        大纲里引用的图片
//   outline.json  --json 才写：完整的大纲，包括不带字的形状
//   frames/       --frames 才出：每页渲染成 01.png、02.png……，对照原稿的样子。
//                 要装 LibreOffice（soffice）和 poppler（pdftoppm）；没装就跳过，大纲照写
// 读和整理在 lib/pptx-read.mjs。它不是 lib/pptx-write.mjs 的逆运算，读回来的东西不拿去再写 PPTX。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { outlineMarkdown, readPptx } from "./lib/pptx-read.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const input = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-o");
if (!input) {
  console.error("用法：node scripts/extract-pptx.mjs <deck.pptx> [-o 目录] [--json] [--frames]");
  process.exit(1);
}
const outDir = path.resolve(opt("-o") ?? input.replace(/\.pptx$/i, "") + "-extract");

let deck;
try {
  deck = readPptx(readFileSync(input));
} catch (e) {
  console.error(`✗ ${input}：${e.message}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "outline.md"), outlineMarkdown(deck));
if (deck.media.size) {
  mkdirSync(path.join(outDir, "media"), { recursive: true });
  for (const [name, data] of deck.media) writeFileSync(path.join(outDir, "media", name), data);
}
if (args.includes("--json")) {
  const { media, ...rest } = deck;
  writeFileSync(path.join(outDir, "outline.json"), JSON.stringify({ pptx: path.resolve(input), ...rest }, null, 2));
}

const blocks = deck.slides.flatMap((s) => s.blocks);
const count = (kind) => blocks.filter((b) => b.kind === kind).length;
console.log(`大纲：${path.join(outDir, "outline.md")}（${deck.slides.length} 页）`);
console.log(
  `  文本框 ${count("text")}、图片 ${count("image")}（文件 ${deck.media.size} 个）、表格 ${count("table")}、图表 ${count("chart")}、` +
    `图示 ${count("diagram")}、不带字的形状 ${count("shape")}`,
);
const hidden = deck.slides.filter((s) => s.hidden).map((s) => s.index);
if (hidden.length) console.log(`  隐藏的页：${hidden.join("、")}`);
if (count("object")) console.log(`  嵌入对象 ${count("object")} 个，内容没取（大纲里只有位置）`);

if (args.includes("--frames")) frames();

/** soffice 转 PDF，pdftoppm 按 1920 宽逐页出图 */
function frames() {
  // 只看命令在不在不够：Homebrew 的 soffice 是个壳，LibreOffice.app 删了它还在
  const missing = ["soffice", "pdftoppm"].filter((cmd) => {
    const r = spawnSync(cmd, [cmd === "pdftoppm" ? "-v" : "--version"], { stdio: "ignore" });
    return r.error || r.status !== 0;
  });
  if (missing.length) {
    console.log(`  没出页面图：要装 ${missing.join("、")}（LibreOffice、poppler）`);
    return;
  }
  const work = mkdtempSync(path.join(tmpdir(), "orca-extract-"));
  try {
    const pdf = spawnSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", work, path.resolve(input)], { encoding: "utf8" });
    const pdfFile = readdirSync(work).find((f) => f.endsWith(".pdf"));
    if (pdf.status !== 0 || !pdfFile) {
      console.log(`  没出页面图：soffice 转 PDF 失败 ${pdf.stderr.trim()}`);
      return;
    }
    const png = spawnSync("pdftoppm", ["-png", "-scale-to-x", "1920", "-scale-to-y", "-1", path.join(work, pdfFile), path.join(work, "p")], { encoding: "utf8" });
    if (png.status !== 0) {
      console.log(`  没出页面图：pdftoppm 失败 ${png.stderr.trim()}`);
      return;
    }
    const dir = path.join(outDir, "frames");
    mkdirSync(dir, { recursive: true });
    // pdftoppm 按页数补零（p-1.png 或 p-01.png），统一成两位
    const pages = readdirSync(work).filter((f) => /^p-\d+\.png$/.test(f));
    for (const f of pages) renameSync(path.join(work, f), path.join(dir, `${String(+f.match(/\d+/)[0]).padStart(2, "0")}.png`));
    console.log(`  页面图：${dir}（${pages.length} 张，LibreOffice 渲染，字体和 PowerPoint 里可能不一样）`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
