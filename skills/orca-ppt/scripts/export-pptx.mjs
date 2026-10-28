// 把一份演示稿导出成 .pptx。网页稿是作品本身，PPTX 是功能不完整的导出选项：
// 每次翻页按 references/transitions.md「导出 PPTX」那张表回退，导完告诉你哪几次翻页降级了。
//
//   node scripts/export-pptx.mjs <deck.html> [-o out.pptx] [--json report.json] [--frames 目录]
//
// 怎么导：用系统 Chrome 打开稿子（和 capture.mjs 一样，不下载浏览器），每页推到转场、
// 入场都放完的那一刻，量每个看得见的元素：
//   - 纯色块、描边、圆角、一层的线性 / 径向渐变 → PowerPoint 原生形状；文字（包括渐变字）→ 原生文本框。
//     一段是作者写的一段（<br> 另起一段），折了行的段交给 PowerPoint 按框宽折，改字时后面的行跟着走；
//     只有一行的（标题）不折。看的那台电脑没装稿子的字体时，PowerPoint 换的字体宽窄不同，折行会变
//   - 图片、视频、SVG、多层渐变、clip-path 这类 PowerPoint 画不出来的 → 截成透明底的图片，
//     报告里写明每一张为什么是图片
// 共享元素（data-id）在两页里都叫 `!!键`，PowerPoint 的「平滑」靠这个名字配对。
// 量和拼在 lib/pptx-export.mjs，应用里导出走的是同一份。
//
// --json 写一份报告：每页的转场、档位、降级、丢掉的东西、转成图片的元素、预期的文字（一段一条），
// 以及包里每个形状对应稿子里哪个元素（shapes：形状名 → 源文件里的选择器）。
// check-pptx.mjs 拿它核对导出的包。
// --frames 把每页量的那一刻截成 01.png、02.png……，和 PPTX 渲染出来的图逐页比。
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VIEW, exportDeck } from "./lib/pptx-export.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const deck = args.find((a, i) => !a.startsWith("-") && !["-o", "--json", "--frames"].includes(args[i - 1]));
if (!deck) {
  console.error("用法：node scripts/export-pptx.mjs <deck.html> [-o out.pptx] [--json report.json]");
  process.exit(1);
}
const out = path.resolve(opt("-o") ?? deck.replace(/\.html?$/, "") + ".pptx");
const jsonOut = opt("--json") ? path.resolve(opt("--json")) : null;
const framesDir = opt("--frames") ? path.resolve(opt("--frames")) : null;

let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(pathToFileURL(path.resolve(deck)).href + "?capture#/0");
  const { pptx, report, frames } = await exportDeck(
    {
      evaluate: (fn, arg) => page.evaluate(fn, arg),
      screenshot: ({ clip, transparent }) => page.screenshot({ clip, omitBackground: !!transparent }),
    },
    { frames: !!framesDir },
  );

  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, pptx);
  if (framesDir) {
    mkdirSync(framesDir, { recursive: true });
    frames.forEach((png, i) => writeFileSync(path.join(framesDir, `${String(i + 1).padStart(2, "0")}.png`), png));
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ deck: path.resolve(deck), pptx: out, ...report, problems }, null, 2));

  console.log(`导出：${out}（${report.slides.length} 页）`);
  if (report.degraded.length) {
    console.log("这几次翻页在 PowerPoint 里和网页不一样：");
    for (const d of report.degraded) {
      const shown = { morph: "平滑", fade: "淡入淡出", wipe: "擦除", none: "无转场" }[d.kind];
      console.log(`  第 ${d.from}→${d.to} 页  ${d.technique}  ${d.tier} → ${shown}`);
    }
  } else console.log("每次翻页都按保真档导出。");
  for (const s of report.slides.filter((s) => s.lost.length)) console.log(`  第 ${s.index} 页导不出来：${s.lost.join("、")}`);
  const rasterCount = report.slides.reduce((a, s) => a + s.rasters.length, 0);
  if (rasterCount) console.log(`${rasterCount} 个元素转成了图片（原因见 --json 报告）`);
  console.log(`用到的字体（看的那台电脑要装）：${report.fonts.join("、")}`);
  if (problems.length) console.log(`页面报错：\n  ${problems.join("\n  ")}`);
} finally {
  await browser?.close().catch(() => {});
}
