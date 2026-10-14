// 导出 PPTX 的核心：量页面、截图、拼包。不管浏览器是谁开的 ——
// 命令行（scripts/export-pptx.mjs）用 playwright 开系统 Chrome，应用用 Electron 自己的内核，
// 都只要交进来一个 page：
//
//   page.evaluate(fn, arg)            在页面里跑 fn(arg)，fn 不能引用外面的变量；返回结果（可以是 Promise）
//   page.screenshot({ clip, transparent })  截视口里的一块，返回 PNG 的 Buffer
//
// 调用方负责把稿子用 `?capture#/0` 打开、视口设成 VIEW。
import { buildPptx } from "./pptx-write.mjs";
import { LOST, pageTransition } from "./pptx-fallback.mjs";

const W = 1920;
const H = 1080;
// 视口比画布大一圈：出画的元素（圆心贴边的圆环、等着入画的共享元素）也要截得到
export const VIEW = { width: W * 3, height: H * 3 };

/**
 * 在页面里跑：量当前页。返回 { background, facts, items }。
 * 每个要导出的元素打上 data-pptx-k，截图时按它找。
 */
function measure(index) {
  const section = Reveal.getSlide(index);
  const origin = section.getBoundingClientRect();
  const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  // 任何 CSS 颜色（rgb / oklch / color(srgb …)）都让浏览器自己换算成 RGBA
  const rgba = (css) => {
    if (!css || css === "transparent") return null;
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = "#000";
    canvas.fillStyle = css;
    canvas.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null;
    return { color: [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""), alpha: a / 255 };
  };
  const withAlpha = (c, o) => (c ? { ...c, alpha: c.alpha * o } : null);

  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n && n !== section.parentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.visibility === "hidden" || cs.display === "none") return 0;
      o *= parseFloat(cs.opacity);
    }
    return o;
  };
  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.left - origin.left, y: b.top - origin.top, w: b.width, h: b.height };
  };
  const outside = (b) => b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= 1920 || b.y >= 1080;
  // 旋转：独立属性 rotate + transform 里的旋转
  const rotationOf = (cs) => {
    let deg = 0;
    const r = cs.rotate;
    if (r && r !== "none") {
      const m = /(-?[\d.]+)deg/.exec(r);
      if (m) deg += +m[1];
    }
    if (cs.transform && cs.transform !== "none") {
      const m = new DOMMatrix(cs.transform);
      deg += (Math.atan2(m.b, m.a) * 180) / Math.PI;
    }
    return deg;
  };
  // 共享元素的键：data-id；匹配放大的 data-match；原地替换、文字级匹配的键也拿来配对
  const identityOf = (el) => {
    for (let n = el; n && n !== section; n = n.parentElement) {
      if (n.dataset.id) return n.dataset.id;
      if (n.dataset.match) return `match-${n.dataset.match}`;
      if (n.dataset.swap) return `swap-${n.dataset.swap}`;
      if (n.dataset.text) return `text-${n.dataset.text}`;
    }
    return null;
  };
  const turnOf = (el) => !!el.closest("[data-st-turn]");
  const label = (el) => {
    const cls = [...el.classList].filter((c) => /^[tsvl]-/.test(c)).join(".");
    return cls || el.tagName.toLowerCase();
  };

  const isInline = (cs) => cs.display.startsWith("inline") || cs.display === "contents";
  const blockOf = (node) => {
    for (let n = node.parentElement; n; n = n.parentElement) if (!isInline(getComputedStyle(n))) return n;
    return section;
  };
  const RASTER_TAGS = new Set(["IMG", "VIDEO", "CANVAS", "svg", "IFRAME", "PICTURE", "OBJECT", "EMBED"]);

  // 页内文字：按「所在的块级元素」分组，每组一个文本框
  const textBlocks = new Map();
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.data.trim()) continue;
    if (t.parentElement.closest("svg")) continue;
    const block = blockOf(t);
    if (!textBlocks.has(block)) textBlocks.set(block, []);
    textBlocks.get(block).push(t);
  }

  const fontOf = (cs) => {
    const families = cs.fontFamily.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
    const cjk = families.find((f) => /SC|TC|CN|JP|KR|Hei|Song|Kai|Ming|PingFang|Hiragino|YaHei|CJK|Han/i.test(f));
    return { font: families[0], ea: cjk ?? families[0] };
  };
  const transformText = (s, cs) =>
    cs.textTransform === "uppercase" ? s.toUpperCase() : cs.textTransform === "lowercase" ? s.toLowerCase() : s;

  function textOf(block, o) {
    const cs = getComputedStyle(block);
    const lines = [];
    const range = document.createRange();
    for (const node of textBlocks.get(block)) {
      const ecs = getComputedStyle(node.parentElement);
      const eo = opacityOf(node.parentElement);
      if (eo < 0.05) continue;
      const fontSize = parseFloat(ecs.fontSize);
      const { font, ea } = fontOf(ecs);
      const style = {
        font,
        ea,
        size: fontSize,
        bold: parseInt(ecs.fontWeight, 10) >= 600,
        italic: ecs.fontStyle === "italic",
        spacing: ecs.letterSpacing === "normal" ? 0 : parseFloat(ecs.letterSpacing) || 0,
        ...(withAlpha(rgba(ecs.color), eo) ?? { color: "000000", alpha: 0 }),
      };
      const key = JSON.stringify(style);
      const chars = [...node.data];
      let at = 0;
      for (const ch of chars) {
        range.setStart(node, at);
        range.setEnd(node, at + ch.length);
        at += ch.length;
        const r = [...range.getClientRects()].find((x) => x.width > 0 || x.height > 0);
        if (!r) continue; // 折叠掉的空白
        const top = r.top - origin.top;
        let line = lines.at(-1);
        if (!line || top > line.top + fontSize * 0.6) {
          line = { top, left: r.left - origin.left, runs: [] };
          lines.push(line);
        }
        const text = /\s/.test(ch) ? " " : transformText(ch, ecs);
        const last = line.runs.at(-1);
        if (last && last.key === key) last.text += text;
        else line.runs.push({ key, ...style, text });
      }
    }
    for (const line of lines) {
      // 行首行尾的空白是排版换行留下的，PowerPoint 里会变成可见的空格
      const first = line.runs[0];
      if (first) first.text = first.text.replace(/^\s+/, "");
      const last = line.runs.at(-1);
      if (last) last.text = last.text.replace(/\s+$/, "");
      line.runs = line.runs.filter((r) => r.text).map(({ key, ...r }) => r);
    }
    const kept = lines.filter((l) => l.runs.length);
    if (!kept.length) return null;
    const align = { center: "ctr", right: "r", end: "r", justify: "just" }[cs.textAlign] ?? "l";
    const lh = cs.lineHeight === "normal" ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight);
    return { align, lineHeight: lh, lines: kept };
  }

  const items = [];
  // 编号每页从 0 起：先清掉前几页留下的标记，否则截图时按编号会同时找到前几页的元素
  for (const el of document.querySelectorAll("[data-pptx-k]")) delete el.dataset.pptxK;
  let k = 0;
  const skipInside = new Set();
  for (const el of section.querySelectorAll("*")) {
    if ([...skipInside].some((s) => s.contains(el))) continue;
    if (el.classList.contains("st-mask")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const o = opacityOf(el);
    if (o < 0.05) continue;
    const b = rect(el);
    if (b.w < 0.5 && b.h < 0.5) continue;
    const identity = identityOf(el);
    if (outside(b) && !identity) continue;
    const rot = rotationOf(cs);
    const turn = turnOf(el);
    // 旋转的元素：盒子按没转的样子量（中心不变，尺寸取布局尺寸），旋转写进 rot
    const geo = rot || turn
      ? { x: b.x + b.w / 2 - el.offsetWidth / 2, y: b.y + b.h / 2 - el.offsetHeight / 2, w: el.offsetWidth, h: el.offsetHeight }
      : b;
    const base = { identity, turn, label: label(el), ...geo, ...(rot || turn ? { rot } : {}) };

    const tag = el.tagName;
    if (RASTER_TAGS.has(tag) || el instanceof SVGSVGElement) {
      el.dataset.pptxK = String(k);
      items.push({ ...base, k: k++, kind: "raster", whole: true, reason: tag === "VIDEO" ? "视频导成静帧" : `<${tag.toLowerCase()}>` });
      skipInside.add(el);
      continue;
    }

    const reasons = [];
    if (cs.backgroundImage !== "none") reasons.push("渐变或背景图");
    if (cs.clipPath !== "none") reasons.push("clip-path");
    if (cs.maskImage && cs.maskImage !== "none") reasons.push("mask");
    // 引擎的动态模糊（url(#st-mb-…)）放完就是 0，不算
    if (cs.filter !== "none" && !/^url\("?#st-mb-/.test(cs.filter) && !/^blur\(0px\)$/.test(cs.filter)) reasons.push("filter");
    const pseudo = ["::before", "::after"].some((p) => {
      const ps = getComputedStyle(el, p);
      return ps.content !== "none" && ps.content !== "normal" && ps.display !== "none";
    });
    if (pseudo) reasons.push("伪元素");
    const sides = ["Top", "Right", "Bottom", "Left"].map((s) => ({
      width: cs[`border${s}Style`] === "none" ? 0 : parseFloat(cs[`border${s}Width`]),
      color: cs[`border${s}Color`],
    }));
    const bordered = sides.some((s) => s.width > 0);
    const uniform = sides.every((s) => s.width === sides[0].width && s.color === sides[0].color);
    if (bordered && !uniform) reasons.push("单边描边");

    if (reasons.length) {
      // 自己的底色和装饰截成图，里面的孩子照常导（文字还是文字）
      el.dataset.pptxK = String(k);
      items.push({ ...base, k: k++, kind: "raster", whole: false, reason: reasons.join("、") });
    } else {
      const fill = withAlpha(rgba(cs.backgroundColor), o);
      const line = bordered ? { ...withAlpha(rgba(sides[0].color), o), width: sides[0].width } : null;
      if (fill || (line && line.color)) {
        const radius = parseFloat(cs.borderTopLeftRadius) || 0;
        const radiusPx = cs.borderTopLeftRadius.endsWith("%") ? (radius / 100) * Math.min(geo.w, geo.h) : radius;
        const round = Math.abs(geo.w - geo.h) < 1 && radiusPx >= geo.w / 2 - 0.5;
        items.push({
          ...base,
          kind: "box",
          geom: round ? "ellipse" : radiusPx > 0.5 ? "roundRect" : "rect",
          radius: radiusPx,
          fill,
          line: line?.color ? line : null,
          owner: el,
        });
      }
    }

    if (textBlocks.has(el)) {
      const text = textOf(el, o);
      if (text) {
        const box = items.at(-1)?.owner === el ? items.at(-1) : null;
        const pad = {
          l: parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
          t: parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth),
          r: parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth),
          b: parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth),
        };
        if (box) box.text = { ...text, insets: pad };
        else items.push({ ...base, kind: "box", geom: "rect", fill: null, line: null, text: { ...text, insets: pad } });
      }
    }
  }
  for (const item of items) delete item.owner;

  // 底色：页自己的背景层 → .reveal → body → html，取第一个不透明的
  let background = null;
  for (const el of [Reveal.getSlideBackground(index), document.querySelector(".reveal"), document.body, document.documentElement]) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.backgroundImage !== "none") {
      background = { raster: true };
      break;
    }
    const c = rgba(cs.backgroundColor);
    if (c) {
      background = { color: c.color };
      break;
    }
  }

  const q = (sel) => !!section.querySelector(sel);
  const facts = {
    st: section.dataset.st || null,
    autoAnimate: section.hasAttribute("data-auto-animate"),
    direction: section.dataset.stDirection || null,
    turn: q("[data-st-turn]"),
    swap: q("[data-swap]"),
    text: q("[data-text]:not([data-roll])"),
    roll: q("[data-roll]"),
    lost: [
      ...(q("[data-anim], [data-step]") ? ["anim"] : []),
      ...(q("video") ? ["video"] : []),
      ...(q("[data-auto-animate-delay]") ? ["rhythm"] : []),
    ],
  };
  return { background: background ?? { color: "ffffff" }, facts, items, origin: { x: origin.left, y: origin.top } };
}


/**
 * 等稿子就绪，逐页量、截，拼成 PPTX。
 * 返回 { pptx: Buffer, report, frames }；frames 只在 options.frames 时有，每页一张 PNG。
 */
export async function exportDeck(page, options = {}) {
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          if (window.__capture?.go && window.Reveal?.isReady?.()) return resolve(true);
          if (Date.now() - t0 > 15000) return reject(new Error("稿子没有录制接口（不是用 skill 的引擎做的稿子？）"));
          setTimeout(tick, 50);
        };
        tick();
      }),
  );
  await page.evaluate(() => document.fonts.ready.then(() => true));
  // 画布固定 1:1，放在大视口正中
  await page.evaluate(() => {
    Reveal.configure({ minScale: 1, maxScale: 1 });
    Reveal.layout();
    return true;
  });
  // 加一段样式，返回拿掉它的办法
  const addStyle = async (css) => {
    const id = await page.evaluate((content) => {
      const el = document.createElement("style");
      el.dataset.pptxStyle = String(Math.random()).slice(2);
      el.textContent = content;
      document.head.append(el);
      return el.dataset.pptxStyle;
    }, css);
    return () => page.evaluate((key) => (document.querySelector(`style[data-pptx-style="${key}"]`)?.remove(), true), id);
  };

  const total = await page.evaluate(() => window.__capture.count());
  const frames = [];
  const media = new Map();
  const slides = [];
  const report = { slides: [] };

  for (let i = 0; i < total; i++) {
    const timing = await page.evaluate((idx) => window.__capture.go(idx), i);
    const settle = timing.transition + Math.max(timing.scene, timing.build ?? 0) + Math.min(timing.video, 1000);
    await page.evaluate((ms) => window.__capture.seek(ms), settle);
    const m = await page.evaluate(measure, i);
    if (options.frames) frames.push(await page.screenshot({ clip: { x: m.origin.x, y: m.origin.y, width: W, height: H } }));

    // 截图：只留目标元素看得见，其余全藏起来，透明底
    const shot = async (style, clip, unrotated) => {
      const remove = await addStyle(style);
      if (unrotated) {
        // auto-animate 给 rotate 挂了过渡，过渡压得过 !important：没关掉的话截到的还是转着的样子，
        // PowerPoint 里再转一次，角度就翻倍了
        const left = await page.evaluate((sel) => {
          const cs = getComputedStyle(document.querySelector(sel));
          return cs.rotate === "none" || cs.rotate === "0deg" ? (cs.transform === "none" ? null : cs.transform) : cs.rotate;
        }, unrotated);
        if (left) throw new Error(`第 ${i + 1} 页 ${unrotated} 截图前没转回 0°（还是 ${left}）`);
      }
      const png = await page.screenshot({ clip, transparent: true });
      await remove();
      return png;
    };
    const hideAll =
      "html, body, .reveal, .reveal-viewport { background: transparent !important; }" +
      ".reveal * { visibility: hidden !important; }";
    const rasters = [];
    const shapes = [];
    for (const item of m.items) {
      if (item.kind !== "raster") {
        shapes.push(item);
        continue;
      }
      // reveal 的 auto-animate 往页面里插 `.reveal [data-auto-animate="running"] [data-auto-animate-target=…]
      // { rotate: … !important }`，选择器得比它具体才压得住
      const k = `[data-pptx-k="${item.k}"]`;
      const sel = `.reveal .slides ${k}${k}${k}${k}`;
      // 旋转的元素截没转的样子，转角写进 rot；盒子就是整个元素（扇形会带着整圆的方块，转的中心才对）
      const style =
        hideAll +
        `${sel}${item.whole ? `, ${sel} *` : ""} { visibility: visible !important; }` +
        (item.rot !== undefined
          ? `${sel} { rotate: none !important; transform: none !important; transition: none !important; animation: none !important; }`
          : "");
      const clip = { x: m.origin.x + item.x, y: m.origin.y + item.y, width: item.w, height: item.h };
      const png = await shot(style, clip, item.rot !== undefined ? sel : null);
      const name = `s${i + 1}-${item.k}.png`;
      media.set(name, png);
      shapes.push({ ...item, media: name });
      rasters.push({ name: item.label, identity: item.identity, reason: item.reason });
    }
    let background = m.background;
    if (background.raster) {
      const png = await shot(".reveal .slides * { visibility: hidden !important; }", {
        x: m.origin.x,
        y: m.origin.y,
        width: W,
        height: H,
      });
      const name = `s${i + 1}-bg.png`;
      media.set(name, png);
      background = { media: name };
    }
    slides.push({ measured: m, shapes, background, timing, rasters });
  }

  // 第二遍：配对和转场要看前后两页
  const model = { slides: [], media };
  slides.forEach((s, i) => {
    const prev = slides[i - 1];
    const ids = (sl) => new Set(sl.shapes.map((x) => x.identity).filter(Boolean));
    const shared = prev ? [...ids(s)].filter((id) => ids(prev).has(id)) : [];
    const facts = { ...s.measured.facts, shared, duration: Math.max(0.3, Math.min(3, s.timing.transition / 1000 || 1)) };
    const transition = i === 0 ? { kind: "none", technique: null, tier: "保真", elements: [] } : pageTransition(facts);

    // 同一个键的几块形状收成一个组，组叫 `!!键`；只有一块就直接给它起这个名字
    const out = [];
    const groups = new Map();
    let n = 0;
    for (const item of s.shapes) {
      const shape =
        item.kind === "raster"
          ? { type: "pic", x: item.x, y: item.y, w: item.w, h: item.h, rot: item.rot, media: item.media }
          : {
              type: "sp",
              x: item.x,
              y: item.y,
              w: item.w,
              h: item.h,
              rot: item.rot,
              geom: item.geom,
              radius: item.radius,
              fill: item.fill,
              line: item.line,
              text: item.text && {
                insets: item.text.insets,
                paras: item.text.lines.map((l) => ({ align: item.text.align, lineHeight: item.text.lineHeight, runs: l.runs })),
              },
            };
      // 没有键的形状名字里带页号：PowerPoint 不会因为名字一样把两页的它们配上
      shape.name = `s${i + 1} ${item.label} ${++n}`;
      if (item.identity) {
        if (!groups.has(item.identity)) {
          const g = { type: "grp", name: `!!${item.identity}`, children: [] };
          groups.set(item.identity, g);
          out.push(g);
        }
        groups.get(item.identity).children.push(shape);
      } else out.push(shape);
    }
    const shapes = out.map((g) => {
      if (g.type !== "grp") return g;
      if (g.children.length === 1) return { ...g.children[0], name: g.name };
      return g;
    });
    model.slides.push({ background: s.background, transition, shapes });

    const lost = [...new Set(s.measured.facts.lost)].map((key) => LOST[key]);
    if (transition.tier === "丢失" && transition.technique) lost.unshift(transition.technique);
    report.slides.push({
      index: i + 1,
      // 判转场用的原始事实：check-pptx 按它独立再判一遍，和包里写的对
      facts: i === 0 ? null : facts,
      transition: { kind: transition.kind, technique: transition.technique, tier: transition.tier, elements: transition.elements, ...(transition.dir ? { dir: transition.dir } : {}) },
      shared,
      identities: [...ids(s)],
      turn: [...new Set(s.shapes.filter((x) => x.turn && x.identity).map((x) => x.identity))],
      rasters: s.rasters,
      texts: s.shapes.filter((x) => x.text).flatMap((x) => x.text.lines.map((l) => l.runs.map((r) => r.text).join(""))),
      lost,
    });
  });

  const title = await page.evaluate(() => document.title);
  const pptx = buildPptx(model, { title });
  report.fonts = [...new Set(slides.flatMap((s) => s.shapes.flatMap((x) => x.text?.lines.flatMap((l) => l.runs.map((r) => r.font)) ?? [])))];
  report.degraded = report.slides
    .filter((s) => s.transition.tier !== "保真")
    .map((s) => ({ from: s.index - 1, to: s.index, technique: [s.transition.technique, ...s.transition.elements.filter((e) => e.tier !== "保真").map((e) => e.name)].filter(Boolean).join(" + "), tier: s.transition.tier, kind: s.transition.kind }));
  return { pptx, report, frames };
}
