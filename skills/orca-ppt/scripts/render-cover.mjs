// 把同款的封面页截成首页卡片用的封面图。
//
//   node scripts/render-cover.mjs recipes/<id>/cover.html [-o recipes/<id>/cover.jpg]
//
// 封面页不是演示稿：它把样片里分在几页的东西拼进一个画面（RECIPE.md 的 poster 指向截出来的图）。
// 页面里铺一个 1920×1080 的 .cover-canvas，只截它。和 capture.mjs 一样用系统 Chrome，不下载浏览器。
import { chromium } from "playwright-core";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const page = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-o");
if (!page) {
  console.error("用法：node scripts/render-cover.mjs recipes/<id>/cover.html [-o 输出.jpg]");
  process.exit(1);
}
const out = path.resolve(args.includes("-o") ? args[args.indexOf("-o") + 1] : page.replace(/\.html?$/, ".jpg"));

const browser = await chromium.launch({ channel: "chrome" });
try {
  const tab = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await tab.goto(pathToFileURL(path.resolve(page)).href);
  await tab.evaluate(() => document.fonts.ready);
  const canvas = tab.locator(".cover-canvas");
  if (!(await canvas.count())) throw new Error("封面页里要有一个 1920×1080 的 .cover-canvas");
  await canvas.screenshot({ path: out, type: "jpeg", quality: 85 });
  console.log(`封面 → ${out}`);
} finally {
  await browser.close();
}
