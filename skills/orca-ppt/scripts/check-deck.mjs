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
// 推到转场、入场和页内动画都放完的那一刻,量的就是声明的布局。

import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 规范数字（安全区这些）和页面类型词表都读 skill 自己的那一份，应用的出稿检查读的也是它们
const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), "../runtime");
const SPEC = JSON.parse(readFileSync(resolve(RUNTIME, "spec.json"), "utf8"));
const PAGE_TYPES = JSON.parse(readFileSync(resolve(RUNTIME, "pages.json"), "utf8")).pages.map((p) => p.id);

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
function auditSlide(spec) {
  const CANVAS_W = 1920;
  const CANVAS_H = 1080;
  // Product showcase is a full-bleed reference demo, not a standard report layout.
  // Its scoped safe area is defined in references/product-showcase.md.
  const productDemo = document.documentElement.dataset.demo === "product-showcase";
  const SAFE = productDemo ? spec.showcaseSafeArea : spec.safeArea;

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
    // Only fully offstage, explicitly paired elements may wait outside the canvas
    // (整组归位的起点、焦点移交的入画 / 出画). Partially clipped elements still fail,
    // as do unmatched accidental overflow elements.
    if (el.dataset.id &&
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
    if (el.matches(".t-on-surface, .t-on-accent")) continue;  // 换成了色块上的字色，已经不是强调色
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
      if (!t.closest(".t-on-accent")) {
        add("强调块上的文字", `${name(t)} 压在 ${name(blk)} 上但没加 .t-on-accent（visual-spec.md:76）`);
      }
    }
  }

  // —— 放在 .s-surface 上的文字必须加 .t-on-surface（visual-spec.md:68）
  //    规范原话是「放在 .s-surface 形状上面的文字用它」—— **所有文字**,不只大数字。
  //    不加就继承 --text,而 --text 是配 --bg 的:页面底浅、面板深的配色(washi 的墨色面板、
  //    midnight)下,深字压深底直接读不出来。.t-metric 更糟,它自己是 --accent-text,
  //    那本来就是给浅页面底准备的深色。
  // 整页 .s-surface（「整页 ↔ 卡片」的底）上的文字同样要加 —— 以前这里跳过整页形状，恰好核不到
  // 封面、结尾这种整页深底。整页底上又压着别的形状时，那块形状上的文字归那块形状管
  const shapes = [...section.querySelectorAll("[class*='s-']")].filter(visible)
    .filter((el) => !isFullBleed(el, box(el)) && !el.classList.contains("s-anchor"));
  for (const panel of [...section.querySelectorAll(".s-surface")].filter(visible)) {
    const pb = box(panel);
    const full = isFullBleed(panel, pb);
    if (full && (panel.classList.contains("s-spot") || panel.classList.contains("st-mask"))) continue;
    for (const t of texts) {
      if (!contains(pb, box(t))) continue;
      if (full && shapes.some((sh) => sh !== panel && contains(box(sh), box(t)))) continue;
      // 类写在外层（名单 <ul class="t-credits t-on-surface"> 里的 <span>）也算
      if (t.closest(".t-on-surface, .t-on-accent")) continue;
      // 强调块压在面板上时,块上的文字归 .t-on-accent 管(上一条已经核过)
      const onAccent = [...section.querySelectorAll(".s-accent, .s-accent-soft")]
        .filter(visible).some((blk) => contains(box(blk), box(t)));
      if (onAccent) continue;
      const what = t.classList.contains("t-metric") ? "面板上的大数字" : "面板上的文字";
      add(what, `${name(t)} 压在 .s-surface 上但没加 .t-on-surface（visual-spec.md:68）`);
    }
  }

  // —— 毛玻璃卡片上的文字必须加 .t-on-glass（visual-spec.md「毛玻璃卡片」）。
  //    玻璃的底是照片，不是 --bg：继承 --text 的话，浅底配色的深字压在暗玻璃上就读不出来
  for (const glass of [...section.querySelectorAll(".s-glass")].filter(visible)) {
    const gb = box(glass);
    for (const t of texts) {
      if (!contains(gb, box(t)) || t.closest(".t-on-glass")) continue;
      add("毛玻璃上的文字", `${name(t)} 压在 .s-glass 上但没加 .t-on-glass（visual-spec.md「毛玻璃卡片」）`);
    }
  }

  return problems;
}

/**
 * 同款 style-swap 框内的示意网页（references/style-swap.md 第 3、4 条）。在页面里跑。
 * stage 是「终态」或「转场 50%」这样的标签：中途只核出框和字叠字，压边只在终态核 ——
 * 移动途中字掠过同样在动的色块边是运动本身，停下来还压着才是错。
 */
function auditMockup(stage) {
  const section = document.querySelector(".slides > section.present");
  const out = [];
  const add = (msg) => out.push({ rule: "示意网页", msg: `${stage}：${msg}` });
  const screenEl = section.querySelector(":scope > .mk-screen");
  if (!screenEl) { add("缺 .mk-screen（网页区域）"); return out; }
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    const o = { l: r.left, t: r.top, r: r.right, b: r.bottom, k: el.dataset.id || [...el.classList].join(".") };
    if (el.tagName === "P") { // nowrap 的字会溢出盒子：盒子和文字取并集
      const g = document.createRange(); g.selectNodeContents(el); const q = g.getBoundingClientRect();
      if (q.width) { o.l = Math.min(o.l, q.left); o.r = Math.max(o.r, q.right); o.t = Math.min(o.t, q.top); o.b = Math.max(o.b, q.bottom); }
    }
    return o;
  };
  const S = rect(screenEl);
  const hit = (a, c) => a.l < c.r - 1 && a.r > c.l + 1 && a.t < c.b - 1 && a.b > c.t + 1;
  const inside = (a, c, tol) => a.l >= c.l - tol && a.r <= c.r + tol && a.t >= c.t - tol && a.b <= c.b + tol;
  const shown = [...section.querySelectorAll(":scope > .mk")].filter((el) => el !== screenEl && +getComputedStyle(el).opacity >= 0.35);
  const texts = shown.filter((el) => el.tagName === "P").map(rect);
  const blocks = shown.filter((el) => el.tagName !== "P").map(rect).filter((b) => !inside(S, b, 2));
  for (const el of shown) {
    const b = rect(el);
    if (!inside(b, S, 2)) add(`${b.k} 出了网页区域`);
  }
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++)
    if (hit(texts[i], texts[j])) add(`${texts[i].k} 和 ${texts[j].k} 叠住`);
  if (stage === "终态") for (const t of texts) for (const b of blocks)
    if (hit(t, b) && !inside(t, b, 2)) add(`${t.k} 压在 ${b.k} 的边上`);
  return out;
}

/**
 * 毛玻璃卡片上的字读不读得动（visual-spec.md「毛玻璃卡片」）。玻璃的底是照片，颜色只有截图里有，
 * DOM 和配色表都量不出来：把玻璃上的字藏起来截一张，量字底下那块的亮度，和字色算对比度。
 * 取亮的那头（第 90 百分位）而不是平均 —— 字压在一块亮斑上就读不动了，平均会把它抹掉。
 */
async function auditGlass(page) {
  const targets = await page.evaluate(() => {
    const section = document.querySelector(".slides > section.present");
    // 转场留下的上一页的字（淡出完 opacity 是 0，还在 DOM 里）不算，沿父链累乘，同 auditSlide
    const shown = (el) => {
      let o = 1;
      for (let n = el; n && n !== section.parentElement; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
      return o >= 0.05;
    };
    const out = [];
    for (const glass of section.querySelectorAll(".s-glass")) {
      if (!shown(glass)) continue;
      const g = glass.getBoundingClientRect();
      for (const t of section.querySelectorAll(".t-on-glass")) {
        if (!shown(t)) continue;
        const b = t.getBoundingClientRect();
        if (b.left < g.left - 1 || b.right > g.right + 1 || b.top < g.top - 1 || b.bottom > g.bottom + 1) continue;
        out.push({ text: (t.textContent || "").trim().slice(0, 18), color: getComputedStyle(t).color,
                   clip: { x: b.left, y: b.top, width: b.width, height: b.height } });
      }
    }
    return out;
  });
  if (!targets.length) return [];
  const hide = await page.addStyleTag({ content: ".slides > section.present .t-on-glass { visibility: hidden !important; }" });
  const problems = [];
  for (const t of targets) {
    const png = (await page.screenshot({ clip: t.clip })).toString("base64");
    const ratio = await page.evaluate(async ({ png, color }) => {
      const lum = (r, g, b) => {
        const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const ctx = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height }).getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      const ls = [];
      for (let i = 0; i < px.length; i += 4) ls.push(lum(px[i], px[i + 1], px[i + 2]));
      ls.sort((a, b) => a - b);
      const bg = ls[Math.floor(ls.length * 0.9)];
      const fg = lum(...color.match(/[\d.]+/g).slice(0, 3).map(Number));
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    }, { png, color: t.color });
    if (ratio < 4.5) {
      problems.push({ rule: "毛玻璃对比度", msg: `「${t.text}」和底下的照片只有 ${ratio.toFixed(2)}:1（要 4.5:1）。换一块暗一点的地方放卡片，或者挪镜头（visual-spec.md「毛玻璃卡片」）`, level: "error" });
    }
  }
  await hide.evaluate((el) => el.remove());
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
  const styleSwap = await page.evaluate(() => document.documentElement.dataset.demo === "style-swap");
  let turns = {};
  for (let i = 0; i < count; i++) {
    // 切到这一页并冻住动画，再把时间轴推到转场、入场和页内动画（data-path 这类）都放完。
    // 页内动画的元素可以从画外开始走（灯从顶上落下来），量起点会误报出界，量的是它停下来的地方
    const { transition, scene } = await page.evaluate((n) => window.__capture.go(n), i);
    if (styleSwap && i > 0) {
      for (const f of [0.3, 0.5, 0.7]) {
        await page.evaluate((ms) => window.__capture.seek(ms), transition * f);
        for (const p of await page.evaluate(auditMockup, `转场 ${f * 100}%`)) found.push({ page: i + 1, ...p });
      }
    }
    await page.evaluate((ms) => window.__capture.seek(ms), transition + (scene || 0));
    const problems = await page.evaluate(auditSlide, SPEC);
    if (styleSwap) problems.push(...(await page.evaluate(auditMockup, "终态")));
    problems.push(...(await auditGlass(page)));
    for (const p of problems) found.push({ page: i + 1, ...p });

    // —— 绕圆心转一次不超过 180°（transitions.md「绕圆心转」）：rotate 按数值插值，
    //    -150° → 150° 是倒着转 300°，不是顺着转 60°。按行内写的角度比，跨页才看得出来
    const now = await page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll(".slides > section.present [data-id]")]
        .filter((el) => el.style.rotate)
        .map((el) => [el.dataset.id, parseFloat(el.style.rotate) || 0])));
    for (const [id, deg] of Object.entries(now)) {
      const was = turns[id] ?? 0;
      if (Math.abs(deg - was) > 180) {
        found.push({ page: i + 1, rule: "绕圆心转", level: "warn",
          msg: `data-id="${id}" 从 ${was}° 转到 ${deg}°，一次转了 ${Math.abs(deg - was)}°（超过 180° 看着像倒转，transitions.md「绕圆心转」）` });
      }
    }
    turns = now;
  }

  // —— 整份稿子的检查：页面类型词表、手法次数、连续同一种手法、镂空聚焦的洞
  const deckInfo = await page.evaluate(() => [...document.querySelectorAll(".slides > section")].map((s) => ({
    page: s.dataset.page || null,
    st: s.dataset.st || null,
    lead: !!s.dataset.stMaskLead,
    spot: (() => { const el = s.querySelector(":scope > .s-spot"); return el && el.offsetWidth ? `${el.offsetWidth}×${el.offsetHeight}` : null; })(),
  })));
  deckInfo.forEach((d, i) => {
    if (d.page && !PAGE_TYPES.includes(d.page)) {
      found.push({ page: i + 1, rule: "页面类型", msg: `data-page="${d.page}" 不在 runtime/pages.json 的词表里（${PAGE_TYPES.join(" / ")}）。认不准就别标（visual-spec.md「页面类型」）` });
    }
  });
  // 次数上限（transitions.md 各手法第 1 条）；带领头元素的遮挡剪辑是开场动作的一部分，不算
  const limits = { "zoom-through": 2, mask: 2, recap: 1 };
  for (const [kind, max] of Object.entries(limits)) {
    const pages = deckInfo.map((d, i) => (d.st === kind && !(kind === "mask" && d.lead) ? i + 1 : 0)).filter(Boolean);
    if (pages.length > max) {
      found.push({ page: pages[max], rule: "手法次数", msg: `data-st="${kind}" 用了 ${pages.length} 次（第 ${pages.join("、")} 页），一份稿子最多 ${max} 次（transitions.md）` });
    }
  }
  // 连续三次同一种 data-st（transitions.md「组合规则」）。元素交接走列表是例外；
  // 共享元素这类没有 data-st 的翻页（含焦点移交、绕圆心转）从 DOM 上分不出手法，不在这里核
  for (let i = 3; i < deckInfo.length; i++) {
    const run = deckInfo.slice(i - 2, i + 1).map((d) => d.st);
    if (run[0] && run[0] !== "carry" && run.every((k) => k === run[0])) {
      found.push({ page: i + 1, rule: "组合规则", level: "warn", msg: `第 ${i - 1}–${i + 1} 页连续三次 data-st="${run[0]}"（transitions.md「组合规则」）` });
    }
  }
  const spots = [...new Set(deckInfo.map((d) => d.spot).filter(Boolean))];
  if (spots.length > 1) {
    found.push({ page: deckInfo.findIndex((d) => d.spot === spots[1]) + 1, rule: "镂空聚焦", msg: `洞的大小前后不一致（${spots.join("、")}），只移动不改大小（transitions.md「镂空聚焦」）` });
  }

  // —— 行内样式（visual-spec.md「颜色和形状」）：读源文件，看作者写了什么。
  //    运行起来以后引擎和 reveal 会往元素上写行内颜色，那时候再量就是误报
  const source = readFileSync(file, "utf8");
  const sectionStarts = [...source.matchAll(/<section[\s>]/g)].map((m) => m.index);
  const pageAt = (idx) => sectionStarts.filter((s) => s <= idx).length;
  const COLOR = /(?:^|;)\s*(color|background(?:-color|-image)?|border(?:-[a-z]+)?(?:-color)?|outline(?:-color)?|fill|stroke)\s*:[^;]*?(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\()/;
  for (const m of source.matchAll(/style="([^"]*)"/g)) {
    const page = pageAt(m.index);
    if (!page) continue; // section 之外（页面框架）不管
    const style = m[1];
    const color = style.match(COLOR);
    if (color) found.push({ page, rule: "行内样式", msg: `style 里写了色值「${color[2]}」（${color[1]}）。只写变量 var(--…)，换配色时才会跟着变` });
    if (/font-size\s*:\s*[\d.]+px/.test(style)) found.push({ page, rule: "行内样式", msg: `style 里写了像素字号「${style.match(/font-size\s*:\s*[\d.]+px/)[0]}」。用字号类` });
  }
  // —— 自带样式表（visual-spec.md「颜色和形状」、style-swap.md）：只有同款 style-swap 能引一份，选择器只许管框里的 .mk 元素
  const sheets = [...source.matchAll(/<link\b[^>]*>/g)].map((m) => m[0])
    .filter((tag) => /rel=["']?stylesheet/.test(tag))
    .map((tag) => (tag.match(/href=["']([^"']+)["']/) || [])[1])
    .filter((href) => href && !/^(https?:)?\/\//.test(href) && !/(^|\/)(runtime|node_modules)\//.test(href));
  if (sheets.length && !styleSwap) {
    found.push({ page: 0, rule: "自带样式表", msg: `引了自己的样式表 ${sheets.join("、")}。颜色字体走主题和配色（themes.md）；只有同款 style-swap 框内的示意网页例外` });
  } else if (sheets.length > 1) {
    found.push({ page: 0, rule: "自带样式表", msg: `style-swap 只许一份自带样式表，引了 ${sheets.length} 份（style-swap.md 第 1 条）` });
  } else if (sheets.length) {
    const css = readFileSync(resolve(dirname(file), sheets[0]), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // @keyframes / @font-face 里面的不是选择器；@media 里的照样核
    const plain = css.replace(/@(keyframes|font-face)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").replace(/@[^{]*\{/g, "");
    for (const m of plain.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const sel of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
        if (!/\.mk[\w-]*/.test(sel)) found.push({ page: 0, rule: "自带样式表", msg: `${sheets[0]} 的选择器「${sel}」没带 .mk 类，会选中框外的东西（style-swap.md 第 2 条）` });
      }
    }
  }
  for (const m of source.matchAll(/<[a-z]+[^>]*\s(fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)) {
    const page = pageAt(m.index);
    if (page) found.push({ page, rule: "行内样式", msg: `svg 上写了 ${m[1]}="${m[2]}"。用线条类 .l-*` });
  }
  await page.close();

  const label = relative(process.cwd(), file);
  const errors = found.filter((f) => f.level !== "warn");
  const warns = found.length - errors.length;
  const tail = errors.length === 0 ? (warns ? `✓（${warns} 条提醒）` : "✓") : `✗ ${errors.length} 条`;
  console.log(`${label.padEnd(40)} ${tail}`);
  for (const f of found) {
    console.log(`   ${f.page ? `第 ${f.page} 页` : "全稿"}  ${f.level === "warn" ? "·" : "✗"} [${f.rule}] ${f.msg}`);
  }
  total += errors.length;
}

await browser.close();
console.log(`\n${decks.length} 份稿子，${total} 条要改（提醒不计）`);
process.exit(total === 0 ? 0 : 1);
