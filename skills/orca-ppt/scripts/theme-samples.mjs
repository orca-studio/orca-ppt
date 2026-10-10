// 给每个主题渲一张样张。
//
//   node scripts/theme-samples.mjs
//
// 产物:runtime/themes/samples/<主题>.jpg,进仓库。
//
// **五张样张的内容完全一样**(都来自 samples/sample.html),只有主题不同 ——
// 选主题时人要比的是设计。内容各不相同的话,人只能一份份浏览,没法把几个摆在一起比。
// Keynote 的主题选择器全部用同一句 Lorem Ipsum,就是这个道理。
//
// 为什么不复用 capture.mjs:那个是录转场的,要 engine.js 跑起来、要逐帧 seek。
// 样张只要静止的第一屏,越少动的东西越确定 —— 只跑 reveal(不跑它页面是空的,
// 它的 CSS 默认隐藏所有 section),不加载 gsap 和 engine.js。

import { chromium } from "playwright-core";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THEMES = join(ROOT, "runtime", "themes");
const SAMPLES = join(THEMES, "samples");
const PALETTES = join(ROOT, "runtime", "palettes");
const TEMPLATE = join(SAMPLES, "sample.html");

const allThemes = readdirSync(THEMES)
  .filter((name) => name.endsWith(".css"))
  .map((name) => name.replace(/\.css$/, ""))
  .sort();

/** 主题头里写的「默认配色」。没写就用第一个配色 —— 不配色的话页面是没有颜色的。 */
function defaultPalette(theme) {
  const head = readFileSync(join(THEMES, `${theme}.css`), "utf8").slice(0, 600);
  return (head.match(/默认配色[:：]\s*([a-z0-9-]+)/) || [])[1];
}

/** `--x a,b` 的值；没给就是 undefined。 */
function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * 要渲哪些组合。默认每个主题一张（配它的默认配色）——
 * 选择器上主题是卡片网格，配色是第二个小选择，不做成 主题×配色 的笛卡尔积。
 *
 * `--palette <名字[,名字…]|all>` 换配色渲，产物是 <主题>--<配色>.jpg（不进仓库）：
 *   --palette morandi                 这套配色配得上哪些主题
 *   --theme clearing --palette all    锁一个主题，把全部配色摆开比 —— 差别只剩颜色
 * `--theme <名字[,名字…]>` 只渲这些主题。
 */
const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);

const themes = flag("theme") ? list(flag("theme")) : allThemes;
for (const theme of themes) {
  if (!allThemes.includes(theme)) {
    console.error(`没有这个主题：${theme}（有的是 ${allThemes.join("、")}）`);
    process.exit(1);
  }
}

const allPalettes = readdirSync(PALETTES)
  .filter((name) => name.endsWith(".css"))
  .map((name) => name.replace(/\.css$/, ""))
  .sort();

const forcedArg = flag("palette");
const forcedList = !forcedArg
  ? undefined
  : forcedArg === "all"
    ? allPalettes
    : list(forcedArg);
for (const palette of forcedList ?? []) {
  if (!allPalettes.includes(palette)) {
    console.error(`没有这套配色：${palette}（有的是 ${allPalettes.join("、")}）`);
    process.exit(1);
  }
}

if (themes.length === 0) {
  console.error("runtime/themes 下一个主题都没有");
  process.exit(1);
}

mkdirSync(SAMPLES, { recursive: true });
const template = readFileSync(TEMPLATE, "utf8");

// 用系统里装好的 Chrome，不下载浏览器
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});

const problems = [];
page.on("console", (m) => ["error", "warning"].includes(m.type()) && problems.push(m.text()));
page.on("pageerror", (e) => problems.push(e.message));

let count = 0;

for (const theme of themes) {
  const palettes = forcedList ?? [defaultPalette(theme)];

for (const palette of palettes) {
  // 临时页和模板放同一个目录 —— 样张里的相对路径(tokens.css、reveal 的 reset)
  // 是按那个位置写的,换个地方全失效。
  if (!palette) {
    console.log(`${theme.padEnd(22)} 跳过：主题头里没写「默认配色」`);
    continue;
  }
  const scratch = join(SAMPLES, `.${theme}.tmp.html`);
  writeFileSync(
    scratch,
    template
      .replace("{{THEME}}", `../${theme}.css`)
      .replace("{{PALETTE}}", `../../palettes/${palette}.css`),
  );
  try {
    await page.goto(pathToFileURL(scratch).href);
    await page.waitForFunction(() => window.Reveal?.isReady?.());
    // 字体没到就截,截到的是退路字体 —— 而字体正是主题之间差别最大的一项。
    await page.evaluate(() => document.fonts.ready);
    // 排版算完再截。reveal 就绪和布局落定之间还差一拍缩放计算。
    await page.waitForFunction(() => document.querySelector('.slides > section.present') !== null);
    await page.screenshot({
      path: join(SAMPLES, forcedList ? `${theme}--${palette}.jpg` : `${theme}.jpg`),
      type: "jpeg",
      quality: 88,
    });
    count += 1;
    console.log(`${theme.padEnd(22)} ✓  配色 ${palette}`);
  } finally {
    rmSync(scratch, { force: true });
  }
}
}

await browser.close();
if (problems.length > 0) {
  console.log(`\n渲染时的告警(${problems.length} 条):`);
  for (const problem of [...new Set(problems)].slice(0, 10)) console.log("  " + problem);
}
console.log(`\n${count} 张样张 → ${SAMPLES}`);
