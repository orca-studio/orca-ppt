// 给同款（或案例）截一张首页卡片用的封面，写成 poster.jpg，并在 frontmatter 里补上 `poster: poster.jpg`。
//
//   node scripts/render-poster.mjs recipes/<id>        # 一个
//   node scripts/render-poster.mjs --all               # 所有还没有 poster 的同款和案例
//   加 --force 连已经有 poster.jpg 的也重截（自带 cover.html 拼的封面不动）
//
// 截哪一刻由 frontmatter 决定：`preview: 2-4` 是看点那几页（从 1 数），`cover: 2.5` 是从看点开头算的第几秒，
// 不写取 75% 处。时间轴和 OrcaPPT 以前首页录样片时一样：从中间页起时，起始页先停 0.6 秒，
// 接着是后面每页的转场和停留。案例不写 preview 就截第一页。
// 和 capture.mjs 一样用系统 Chrome，不下载浏览器。
import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 1280;
const HEIGHT = 720;
const LEAD_IN_MS = 600;
const NAME = "poster.jpg";

const args = process.argv.slice(2);
const force = args.includes("--force");
const homes = args.includes("--all")
  ? ["recipes", "examples"].flatMap((group) =>
      readdirSync(path.join(SKILL, group), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !/^[._]/.test(e.name))
        .map((e) => path.join(SKILL, group, e.name)),
    )
  : args.filter((a) => !a.startsWith("--")).map((a) => path.resolve(a));
if (!homes.length) {
  console.error("用法：node scripts/render-poster.mjs recipes/<id> [--force] | --all [--force]");
  process.exit(1);
}

function readMeta(home) {
  const file = ["RECIPE.md", "EXAMPLE.md"].map((f) => path.join(home, f)).find((f) => existsSync(f));
  if (!file) return undefined;
  const text = readFileSync(file, "utf8");
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const meta = {};
  for (const line of block.split("\n")) {
    const kv = /^([a-z]+):\s*(.*?)\s*(#.*)?$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { file, text, meta, example: file.endsWith("EXAMPLE.md") };
}

const browser = await chromium.launch({ channel: "chrome" });
let failed = 0;
try {
  for (const home of homes) {
    const found = readMeta(home);
    if (!found) continue;
    const { file, text, meta, example } = found;
    const id = path.basename(home);
    if (meta.poster && (!force || meta.poster !== NAME)) {
      console.log(`${id}：已有 poster（${meta.poster}），跳过`);
      continue;
    }
    const deck = path.join(meta.sample ? path.resolve(home, meta.sample) : home, "index.html");
    if (!existsSync(deck)) {
      console.error(`${id}：找不到样稿 ${path.relative(SKILL, deck)}`);
      failed++;
      continue;
    }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(meta.preview ?? "");
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    try {
      await page.goto(pathToFileURL(deck).href + "?capture#/0");
      await page.waitForFunction(() => window.__capture?.go && window.Reveal?.isReady?.());
      await page.evaluate(() => document.fonts.ready);
      const count = await page.evaluate(() => window.__capture.count());
      const from = Math.min(range ? +range[1] - 1 : 0, count - 1);
      const to = Math.min(range ? +range[2] - 1 : example ? 0 : count - 1, count - 1);

      // 先把时间轴量出来：每段是 [起点, 时长, 定位方法]
      const segments = [];
      let t = 0;
      if (from > 0) {
        // 先停到起始页：隔页跳的话下一页报的转场时长是 0，后面的时间全对不上
        await page.evaluate((n) => window.__capture.go(n), from);
        await page.evaluate(() => window.__capture.seek(10_000_000));
        segments.push({ start: t, length: LEAD_IN_MS, index: from, settled: true });
        t += LEAD_IN_MS;
      }
      for (let i = from > 0 ? from + 1 : 0; i <= to; i++) {
        const { transition, hold, scene, video } = await page.evaluate((n) => window.__capture.go(n), i);
        segments.push({ start: t, length: transition, index: i, offset: 0 });
        t += transition;
        // 停留：画面还在动的逐毫秒定位，静止的就停在转场终点
        segments.push({ start: t, length: Math.max(hold, 1000 / 24), index: i, offset: transition, moving: scene || video });
        t += Math.max(hold, 1000 / 24);
      }
      const cover = Number(meta.cover);
      const at = Number.isFinite(cover) && meta.cover !== "" ? cover * 1000 : t * 0.75;
      const hit = segments.find((s) => at < s.start + s.length) ?? segments.at(-1);
      // 量时间轴时已经翻到最后一页了。直接跳回去，转场会从错的那一页变过来（形态变换、共享元素都靠上一页），
      // 所以重新打开，按放映的顺序一页页翻到目标页，每页都停在转场终点
      await page.reload();
      await page.waitForFunction(() => window.__capture?.go && window.Reveal?.isReady?.());
      await page.evaluate(() => document.fonts.ready);
      if (from > 0) {
        await page.evaluate((n) => window.__capture.go(n), from);
        await page.evaluate(() => window.__capture.seek(10_000_000));
      }
      for (let i = from > 0 ? from + 1 : 0; i < hit.index; i++) {
        await page.evaluate((n) => window.__capture.go(n), i);
        await page.evaluate(() => window.__capture.seek(10_000_000));
      }
      if (!(hit.settled && hit.index === from)) await page.evaluate((n) => window.__capture.go(n), hit.index);
      const ms = hit.settled ? 10_000_000 : hit.moving || !hit.offset ? hit.offset + (at - hit.start) : hit.offset;
      await page.evaluate((v) => window.__capture.seek(v), Math.max(0, ms));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const out = path.join(home, NAME);
      await page.screenshot({ path: out, type: "jpeg", quality: 82 });
      if (!meta.poster) {
        writeFileSync(file, text.replace(/\n---\n/, `\nposter: ${NAME}\n---\n`));
      }
      console.log(`${id}：第 ${hit.index + 1} 页，${(at / 1000).toFixed(2)} 秒 → ${path.relative(SKILL, out)}`);
    } catch (error) {
      console.error(`${id}：${error instanceof Error ? error.message : error}`);
      failed++;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
