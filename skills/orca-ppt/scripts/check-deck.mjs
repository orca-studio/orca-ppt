// 核一份稿子有没有违反 visual-spec.md 里那些写死了数值的规则。
//
//   node scripts/check-deck.mjs <deck.html> [更多稿子…]
//   node scripts/check-deck.mjs examples/*/index.html
//   npm run deck
//
// **为什么是事后验，不是发母版**：规范里那二十几条「最多一个」「不超过 15%」「必须加」
// 全是**约束**,没有一条是坐标 —— 它们不要求你把东西放哪,只要求你放完之后对得上。
// 约束能事后验,就不必事前锁死构图;锁死构图换来的那点确定性,代价是编排能力归零,
// 那就退回 Keynote 预设主题了。坐标留给内容去定,这里只拦真错的。
//
// 所以这里**只核不依赖页面类型标注的规则** —— 靠 DOM 和类名就能判的那些。
// 「列表页条目最多 6 行」这类要先知道这是列表页,而 data-page 稿子里大多没标,
// 认错页型比不认更糟。Bento 的「卡片类型至少三种」同理:类型在 HTML 里根本没有标记。
//
// 量的是**入场播完之后的静态布局**。engine.js 必须跑(Reveal.initialize 写在它里面,
// 拦掉的话 reveal 永远不就绪,一个元素都量不到),但它的入场动画会把元素变形 ——
// grow-up 的柱子初始是 scaleY(0),这时候量高度是 0。所以借 capture.mjs 用的那套
// `window.__capture`:`go(i)` 切到第 i 页并冻住全部动画,`seek(transition)` 把时间轴
// 推到转场和入场都放完的那一刻,量的就是声明的布局。

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const decks = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (decks.length === 0) {
  console.error("用法：node scripts/check-deck.mjs <deck.html> [更多稿子…]");
  process.exit(1);
}

/**
 * 在页面里跑。返回当前页的问题数组。
 *
 * 每条规则都标了出处,改规则先去改那儿 —— 这个脚本是 visual-spec.md 的执行端,
 * 不是第二处规范。
 */
function auditSlide() {
  const CANVAS_W = 1920;
  const CANVAS_H = 1080;
  // Product showcase is a full-bleed reference demo, not a standard report layout.
  // Its scoped safe area and paired offstage poses are defined in references/product-showcase.md.
  const productDemo = document.documentElement.dataset.demo === "product-showcase";
  const SAFE = productDemo
    ? { left: 72, right: 1848, top: 48, bottom: 1000 }
    : { left: 120, right: 1800, top: 80, bottom: 1000 };

  const section = document.querySelector(".slides > section.present");
  if (!section) return [{ rule: "内部", msg: "找不到当前页" }];

  const problems = [];
  const add = (rule, msg, level = "error") => problems.push({ rule, msg, level });
  const box = (el) => {
    const s = el.getBoundingClientRect();
    const r = section.getBoundingClientRect();
    return { left: s.left - r.left, top: s.top - r.top, width: s.width, height: s.height,
             right: s.right - r.left, bottom: s.bottom - r.top };
  };
  const name = (el) => {
    const cls = [...el.classList].filter((c) => /^[tsl]-|^v-/.test(c)).join(".");
    const text = (el.textContent || "").trim().slice(0, 18);
    return (cls ? "." + cls : el.tagName.toLowerCase()) + (text ? ` 「${text}」` : "");
  };

  /**
   * 转场会在页面里留下**上一页的元素**（多合一、元素交接都是这么实现的），
   * 转场结束时它们 opacity 已经是 0，但还在 DOM 里，getBoundingClientRect 照样有值。
   * 不滤掉的话，第 3 页会报出第 2 页那些色块，而且把「一页最多一个」全判挂。
   * 沿父链累乘 —— 转场有时把 opacity 设在祖先上，只看元素自己会漏。
   */
  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n && n !== section.parentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.visibility === "hidden" || cs.display === "none") return 0;
      o *= parseFloat(cs.opacity);
      if (o < 0.05) return 0;
    }
    return o;
  };
  // .s-anchor 是视频页的隐形锚，天生 opacity:0，但规范说它的位置照常校验
  const visible = (el) => el.classList.contains("s-anchor") || opacityOf(el) >= 0.05;

  const all = [...section.querySelectorAll("*")].filter(visible);

  /**
   * 铺满画布的整页形状、遮挡剪辑的色块、整页视频 —— 它们本来就该出界。
   * .s-spot 也算:它的幕布靠 box-shadow 铺满整屏,bounding box 量到的是**洞**,
   * 而规范说洞的直径要让整张卡片落进去、「旁边的卡片被圆边切到一点没关系」——
   * 洞本来就允许切到画面边缘,拿安全区去量它是量错了对象。
   */
  const isFullBleed = (el, b) =>
    b.width >= CANVAS_W - 1 || b.height >= CANVAS_H - 1 ||
    el.classList.contains("st-mask") || el.classList.contains("v-full") ||
    el.classList.contains("s-spot");

  // —— 安全区（visual-spec.md「画布和网格」：内容不许超出 left 120~1800、top 80~1000）
  //    容差 8px：量的是 bounding box，描边（.s-ring 这类 border 圆）和字形的
  //    抗锯齿边会把它撑大几个像素。4px 的溢出是度量误差，不是构图错误。
  const SLACK = 8;
  for (const el of all) {
    if (!el.getAttribute("style")?.includes("left")) continue;
    const b = box(el);
    if (b.width === 0 && b.height === 0) continue;
    if (isFullBleed(el, b)) continue;
    // Only fully offstage, explicitly paired elements may wait outside the canvas.
    // Partially clipped elements still fail, as do unmatched accidental overflow elements.
    if (productDemo && el.dataset.id &&
        (b.bottom <= 0 || b.top >= CANVAS_H || b.right <= 0 || b.left >= CANVAS_W) &&
        [...document.querySelectorAll(".slides > section [data-id]")].some((other) =>
          other !== el && other.closest("section") !== section &&
          other.dataset.id === el.dataset.id && other.tagName === el.tagName)) continue;
    const out = [];
    if (b.left < SAFE.left - SLACK) out.push(`左 ${Math.round(b.left)}`);
    if (b.right > SAFE.right + SLACK) out.push(`右 ${Math.round(b.right)}`);
    if (b.top < SAFE.top - SLACK) out.push(`上 ${Math.round(b.top)}`);
    if (b.bottom > SAFE.bottom + SLACK) out.push(`下 ${Math.round(b.bottom)}`);
    if (out.length) add("安全区", `${name(el)} 超出（${out.join("，")}）`);
  }

  // —— 强调色面积 ≤ 15%（visual-spec.md:88）
  const accentSel = ".s-accent, .s-dot, .t-metric, .t-accent";
  let accentArea = 0;
  for (const el of [...section.querySelectorAll(accentSel)].filter(visible)) {
    const b = box(el);
    if (isFullBleed(el, b)) continue;      // 遮挡剪辑的满屏色块不算
    accentArea += b.width * b.height;
  }
  const pct = (accentArea / (CANVAS_W * CANVAS_H)) * 100;
  // 只提醒，不判失败：算的是 bounding box 求和，对 .t-metric / .t-accent 这类**文字**
  // 系统性高估 —— 一行字的盒子里大半是空白，但整个盒子都被算进强调色面积。
  // 16~18% 这一带落在度量误差里，判失败会让人去改没错的东西。
  if (pct > 15) add("强调色面积", `占 ${pct.toFixed(1)}%，超过 15%（visual-spec.md:88；按 bounding box 求和，文字偏高估）`, "warn");

  // —— 一页最多一个（visual-spec.md:27 的 .t-metric、:81 的 .s-spot）
  for (const [sel, what, where] of [
    [".t-metric", "关键数字 .t-metric", "visual-spec.md:27"],
    [".s-spot", "聚焦的洞 .s-spot", "visual-spec.md:81"],
  ]) {
    const n = [...section.querySelectorAll(sel)].filter(visible).length;
    if (n > 1) add("一页最多一个", `${what} 有 ${n} 个（${where}）`);
  }

  // —— .s-dot 宽高必须相等（visual-spec.md:80）
  for (const el of [...section.querySelectorAll(".s-dot")].filter(visible)) {
    const b = box(el);
    if (Math.abs(b.width - b.height) > 1) {
      add("圆点", `${name(el)} 宽高不等（${Math.round(b.width)}×${Math.round(b.height)}），visual-spec.md:80`);
    }
  }

  // —— 文字被截断：写了 width 的不换行文字，内容放不下
  for (const el of [...section.querySelectorAll(".t-display, .t-metric, .t-h1, .t-label")].filter(visible)) {
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      add("文字截断", `${name(el)} 放不下（需要 ${el.scrollWidth}，只有 ${el.clientWidth}）`);
    }
  }

  // —— 需要换行的 .t-h2 / .t-body 必须写 width（visual-spec.md:49）
  //    「需要换行」按内容实际撑开的宽度判:没写 width 又撑得很宽,就是该写没写。
  for (const el of [...section.querySelectorAll(".t-h2, .t-body")].filter(visible)) {
    const style = el.getAttribute("style") || "";
    if (/(^|;|\s)width\s*:/.test(style)) continue;
    const b = box(el);
    if (b.width > 600) {
      add("缺 width", `${name(el)} 没写 width，内容撑到 ${Math.round(b.width)}px（visual-spec.md:49）`);
    }
  }

  // —— 折线最多 3 条（visual-spec.md:193）
  for (const svg of section.querySelectorAll("svg")) {
    const lines = svg.querySelectorAll(".l-accent, .l-surface, .l-text").length;
    if (lines > 3) add("折线", `一个 svg 里有 ${lines} 条线，最多 3 条（visual-spec.md:193）`);
  }

  // —— 压在强调块上的文字必须加 .t-on-accent（visual-spec.md:76）
  //    这条抓的是「全局只有一个文字色，总有一套配色的字会在强调色上消失」那类 bug。
  const contains = (outer, inner) =>
    inner.left >= outer.left - 1 && inner.right <= outer.right + 1 &&
    inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;

  const texts = [...section.querySelectorAll("p, h1, h2, h3, span, div")]
    .filter((el) => (el.textContent || "").trim() && el.children.length === 0 && visible(el));

  for (const blk of [...section.querySelectorAll(".s-accent, .s-accent-soft")].filter(visible)) {
    const bb = box(blk);
    if (isFullBleed(blk, bb)) continue;
    for (const t of texts) {
      if (!contains(bb, box(t))) continue;
      if (!t.classList.contains("t-on-accent")) {
        add("强调块上的文字", `${name(t)} 压在 ${name(blk)} 上但没加 .t-on-accent（visual-spec.md:76）`);
      }
    }
  }

  // —— 放在 .s-surface 上的文字必须加 .t-on-surface（visual-spec.md:68）
  //    规范原话是「放在 .s-surface 形状上面的文字用它」—— **所有文字**,不只大数字。
  //    不加就继承 --text,而 --text 是配 --bg 的:页面底浅、面板深的配色(washi 的墨色面板、
  //    midnight)下,深字压深底直接读不出来。.t-metric 更糟,它自己是 --accent-text,
  //    那本来就是给浅页面底准备的深色。
  for (const panel of [...section.querySelectorAll(".s-surface")].filter(visible)) {
    const pb = box(panel);
    if (isFullBleed(panel, pb)) continue;
    for (const t of texts) {
      if (!contains(pb, box(t))) continue;
      if (t.classList.contains("t-on-surface") || t.classList.contains("t-on-accent")) continue;
      // 强调块压在面板上时,块上的文字归 .t-on-accent 管(上一条已经核过)
      const onAccent = [...section.querySelectorAll(".s-accent, .s-accent-soft")]
        .filter(visible).some((blk) => contains(box(blk), box(t)));
      if (onAccent) continue;
      const what = t.classList.contains("t-metric") ? "面板上的大数字" : "面板上的文字";
      add(what, `${name(t)} 压在 .s-surface 上但没加 .t-on-surface（visual-spec.md:68）`);
    }
  }

  return problems;
}

const browser = await chromium.launch({ channel: "chrome" });
let total = 0;

for (const deck of decks) {
  const file = resolve(deck);
  if (!existsSync(file)) {
    console.log(`${relative(process.cwd(), file)}  ✗ 文件不存在`);
    total += 1;
    continue;
  }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => window.__capture && (!window.Reveal || window.Reveal.isReady?.()));
  await page.evaluate(() => document.fonts.ready);

  const count = await page.evaluate(() => window.__capture.count());
  const found = [];
  for (let i = 0; i < count; i++) {
    // 切到这一页并冻住动画，再把时间轴推到转场和入场都放完
    const { transition } = await page.evaluate((n) => window.__capture.go(n), i);
    await page.evaluate((ms) => window.__capture.seek(ms), transition);
    const problems = await page.evaluate(auditSlide);
    for (const p of problems) found.push({ page: i + 1, ...p });
  }
  await page.close();

  const label = relative(process.cwd(), file);
  const errors = found.filter((f) => f.level !== "warn");
  const warns = found.length - errors.length;
  const tail = errors.length === 0 ? (warns ? `✓（${warns} 条提醒）` : "✓") : `✗ ${errors.length} 条`;
  console.log(`${label.padEnd(40)} ${tail}`);
  for (const f of found) {
    console.log(`   第 ${f.page} 页  ${f.level === "warn" ? "·" : "✗"} [${f.rule}] ${f.msg}`);
  }
  total += errors.length;
}

await browser.close();
console.log(`\n${decks.length} 份稿子，${total} 条要改（提醒不计）`);
process.exit(total === 0 ? 0 : 1);
