// 导出 PPTX 的核心：量页面、截图、拼包。不管浏览器是谁开的 ——
// 命令行（scripts/export-pptx.mjs）用 playwright 开系统 Chrome，应用用 Electron 自己的内核，
// 都只要交进来一个 page：
//
//   page.evaluate(fn, arg)            在页面里跑 fn(arg)，fn 不能引用外面的变量；返回结果（可以是 Promise）
//   page.screenshot({ clip, transparent, quality })  截视口里的一块，返回 PNG 的 Buffer；给了 quality 返回这个质量的 JPG
//
// 调用方负责把稿子用 `?capture#/0` 打开、视口设成 VIEW。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { buildPptx } from "./pptx-write.mjs";
import { LOST, pageTransition } from "./pptx-fallback.mjs";
import { opaque } from "./png.mjs";
import { eot } from "./ttf.mjs";

const W = 1920;
const H = 1080;
// 视口比画布大一圈：出画的元素（圆心贴边的圆环、等着入画的共享元素）也要截得到
export const VIEW = { width: W * 3, height: H * 3 };
// 不透明截图存 JPG 的质量：85 在 1920 宽的油画背景上看不出块，一张 3MB 的 PNG 变 0.4MB
const JPG_QUALITY = 85;

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

  // 一层线性 / 径向渐变 → PowerPoint 的渐变填充（{ grad }）。认不准的（多层、平铺、calc、
  // 非居中的径向、颜色提示）返回 null，照旧截成图
  const splitTop = (s) => {
    const parts = [];
    let depth = 0, from = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      else if (s[i] === "," && depth === 0) {
        parts.push(s.slice(from, i).trim());
        from = i + 1;
      }
    }
    parts.push(s.slice(from).trim());
    return parts;
  };
  // 圆角半径 ≥ 50%：长宽一样是圆，不一样是椭圆（不是两头圆的胶囊）
  const ovalOf = (cs, w, h) => {
    const r = parseFloat(cs.borderTopLeftRadius) || 0;
    return cs.borderTopLeftRadius.endsWith("%") ? r >= 50 : Math.abs(w - h) < 1 && r >= w / 2 - 0.5;
  };
  function gradientOf(cs, w, h, o) {
    const oval = ovalOf(cs, w, h);
    const m = /^(linear|radial)-gradient\((.*)\)$/.exec(cs.backgroundImage);
    if (!m || splitTop(cs.backgroundImage).length > 1) return null;
    if (!/^(auto|auto auto|100% 100%)$/.test(cs.backgroundSize)) return null;
    const [type, body] = [m[1], m[2]];
    const parts = splitTop(body);
    let len, angle = 0, scale = 1, path = null;
    if (type === "linear") {
      // 方向换成单位向量（y 朝下）：0deg 朝上，顺时针
      let v = { x: 0, y: 1 };
      if (/^(to |-?[\d.]+(deg|turn|rad|grad))/.test(parts[0])) {
        const dir = parts.shift();
        if (dir.startsWith("to ")) {
          const sx = /right/.test(dir) ? 1 : /left/.test(dir) ? -1 : 0;
          const sy = /bottom/.test(dir) ? 1 : /top/.test(dir) ? -1 : 0;
          // 朝角落：渐变线垂直于另外两个角的连线
          v = sx && sy ? { x: sx * h, y: sy * w } : { x: sx, y: sy };
        } else {
          const n = parseFloat(dir);
          const deg = dir.endsWith("turn") ? n * 360 : dir.endsWith("grad") ? n * 0.9 : dir.endsWith("rad") ? (n * 180) / Math.PI : n;
          v = { x: Math.sin((deg * Math.PI) / 180), y: -Math.cos((deg * Math.PI) / 180) };
        }
      }
      const a = Math.atan2(v.y, v.x);
      len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
      // PowerPoint 的 lin ang：0 朝右，顺时针
      angle = (((a * 180) / Math.PI) % 360 + 360) % 360;
    } else {
      // 只认圆心居中、贴边（closest-side）或到角（farthest-corner，默认）的
      let shape = "ellipse";
      if (/^(circle|ellipse|closest|farthest)/.test(parts[0])) {
        const conf = parts.shift();
        if (/ at /.test(conf) && !/ at (50% 50%|center( center)?)$/.test(conf)) return null;
        const size = conf.replace(/ at .*$/, "");
        if (!/^((circle|ellipse) )?(closest-side|farthest-corner)?$|^(circle|ellipse)$/.test(size)) return null;
        if (size.includes("circle") && Math.abs(w - h) > 1) return null;
        shape = size.includes("closest-side") ? "side" : "corner";
      } else shape = "corner";
      if (Math.abs(w - h) < 1) {
        // PowerPoint 的圆形路径是正圆，100% 落在外框的四个角，正好是 farthest-corner；
        // closest-side 的 100% 在边上，离圆心只有到角的 1/√2
        path = "circle";
        len = shape === "side" ? w / 2 : w / Math.SQRT2;
        scale = shape === "side" ? Math.SQRT1_2 : 1;
      } else if (oval && shape === "side") {
        // 椭圆形状：沿形状走的路径，等高线是椭圆，100% 在边上，就是 closest-side
        path = "shape";
        len = w / 2;
      } else return null; // 长方形里的椭圆渐变 PowerPoint 画不出来（圆形路径不随长宽比拉伸）
    }
    const stops = [];
    for (const p of parts) {
      const cm = /^((?:[a-z-]+\([^)]*\))|[a-z]+)\s*(.*)$/i.exec(p);
      if (!cm) return null;
      const c = rgba(cm[1]) ?? { color: "000000", alpha: 0 };
      const pos = cm[2] ? cm[2].split(/\s+/) : [];
      if (pos.length > 2) return null;
      const at = (s) => (s.endsWith("%") ? parseFloat(s) / 100 : s.endsWith("px") ? parseFloat(s) / len : NaN);
      if (pos.some((s) => Number.isNaN(at(s)))) return null;
      if (!pos.length) stops.push({ ...c, pos: null });
      for (const s of pos) stops.push({ ...c, pos: at(s) });
    }
    if (stops.length < 2) return null;
    // 没写位置的：首 0、尾 1，中间均分；位置不许倒退
    if (stops[0].pos === null) stops[0].pos = 0;
    if (stops.at(-1).pos === null) stops.at(-1).pos = 1;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].pos !== null) continue;
      let j = i;
      while (stops[j].pos === null) j++;
      for (let k = i; k < j; k++) stops[k].pos = stops[i - 1].pos + ((stops[j].pos - stops[i - 1].pos) * (k - i + 1)) / (j - i + 1);
    }
    for (let i = 1; i < stops.length; i++) stops[i].pos = Math.max(stops[i].pos, stops[i - 1].pos);
    if (stops[0].pos < 0 || stops.at(-1).pos > 1) return null;
    // 底色会从渐变的透明处透出来，PowerPoint 一个形状只有一种填充
    if (rgba(cs.backgroundColor) && stops.some((s) => s.alpha < 1)) return null;
    const out = stops.map((s) => ({ pos: s.pos * scale, color: s.color, alpha: s.alpha * o }));
    // 最后一个颜色铺到外面（CSS 里渐变画完之后就是它）
    if (scale < 1) out.push({ ...out.at(-1), pos: 1 });
    return { grad: { type, angle, ...(path ? { path } : {}), stops: out } };
  }

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
  // 从这个元素到页面，一路上的旋转、缩放叠起来（只要线性部分，平移不管）。吊灯的吊线自己不转，
  // 转的是外面那层 .lamp-rig；只看自己会把斜着的细线量成它的外接框，导成一个大方块
  const linearOf = (el) => {
    let m = new DOMMatrix();
    for (let n = el; n && n !== section; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const own = new DOMMatrix();
      const r = /(-?[\d.]+)deg/.exec(cs.rotate || "");
      if (r) own.rotateSelf(+r[1]);
      const sc = (cs.scale || "none") === "none" ? null : cs.scale.split(/\s+/).map(Number);
      if (sc) own.scaleSelf(sc[0], sc[1] ?? sc[0]);
      if (cs.transform && cs.transform !== "none") own.multiplySelf(new DOMMatrix(cs.transform));
      own.e = own.f = 0;
      m = own.multiply(m);
    }
    return m;
  };
  // 共享元素的键：data-id；匹配放大的 data-match；原地替换、文字级匹配的键也拿来配对
  const identityOf = (el) => {
    for (let n = el; n && n !== section; n = n.parentElement) {
      if (n.dataset.id) return n.dataset.id;
      if (n.dataset.match) return `match-${n.dataset.match}`;
      if (n.dataset.swap) return `swap-${n.dataset.swap}`;
      if (n.dataset.flip) return `flip-${n.dataset.flip}`;
      if (n.dataset.text) return `text-${n.dataset.text}`;
    }
    return null;
  };
  const turnOf = (el) => !!el.closest("[data-st-turn]");
  // 元素在源文件里的位置：引擎在录制模式下改页面之前记在 data-pptx-src 上（从 .slides 起一路 :nth-child）。
  // 报告里按形状名对上它，PowerPoint 或验证器指出的问题能落回 HTML 里的那个元素。
  // 引擎自己搭的层（包层、遮罩）没有，取最近一个有的祖先
  const selectorOf = (el) => el.closest("[data-pptx-src]")?.dataset.pptxSrc ?? null;
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

  // 渐变字（background-clip: text）：一层能认的线性 / 径向渐变 → 字的渐变填充（还是能改的字）。
  // 认不出的（多层、平铺、带 filter 的扫光）整块截成图，字不进文本框（和文字镂空一样，在 PowerPoint 里不能改字）
  const clipsText = (el) => {
    const cs = getComputedStyle(el);
    return cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text";
  };
  const textGradients = new Map();
  const textGradient = (el) => {
    if (!textGradients.has(el)) {
      const cs = getComputedStyle(el);
      const ok = cs.filter === "none" && !["::before", "::after"].some((p) => getComputedStyle(el, p).content !== "none" && getComputedStyle(el, p).content !== "normal");
      textGradients.set(el, ok ? gradientOf(cs, el.offsetWidth, el.offsetHeight, 1) : null);
    }
    return textGradients.get(el);
  };
  const clipOf = (node) => {
    for (let n = node.parentElement; n && n !== section; n = n.parentElement) if (clipsText(n)) return n;
    return null;
  };
  const gradientText = (node) => {
    const clip = clipOf(node);
    return !!clip && !textGradient(clip);
  };

  // 页内文字：按「所在的块级元素」分组，每组一个文本框
  const textBlocks = new Map();
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.data.trim()) continue;
    if (t.parentElement.closest("svg")) continue;
    if (gradientText(t)) continue;
    const block = blockOf(t);
    if (!textBlocks.has(block)) textBlocks.set(block, []);
    textBlocks.get(block).push(t);
  }

  const fontOf = (cs) => {
    const families = cs.fontFamily.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
    // 不忽略大小写：「Hanken Grotesk」里的 Han、「Source Serif」里的 Sc 都不是中文字体
    const cjk = families.find((f) => /\b(SC|TC|HK|CN|JP|KR)\b|Hei|Song|Kai|Ming|PingFang|Hiragino|YaHei|CJK|Source Han|SimSun|STSong|FangSong/.test(f));
    return { font: families[0], ea: cjk ?? families[0] };
  };
  const transformText = (s, cs) =>
    cs.textTransform === "uppercase" ? s.toUpperCase() : cs.textTransform === "lowercase" ? s.toLowerCase() : s;

  // 竖排标点：浏览器靠字体的 vert 特性把「，。」挪到字格右上角，Mac 版 PowerPoint 不套这个特性，
  // 标点落在左下角，像挂在下一个字头上。导出时直接换成 Unicode 的竖排专用字符（U+FE10–FE19、FE30–FE44）
  const VERTICAL_PUNCT = {
    "，": "\uFE10", "、": "\uFE11", "。": "\uFE12", "：": "\uFE13", "；": "\uFE14", "！": "\uFE15", "？": "\uFE16",
    "…": "\uFE19", "—": "\uFE31", "（": "\uFE35", "）": "\uFE36", "《": "\uFE3D", "》": "\uFE3E",
    "「": "\uFE41", "」": "\uFE42", "『": "\uFE43", "』": "\uFE44",
  };
  function textOf(block, o) {
    const cs = getComputedStyle(block);
    // 竖排（writing-mode: vertical-rl）：一「行」是一列，从右往左排。按列分组，写进 PowerPoint 的竖排文本框（eaVert）。
    // 按横排的办法按 top 分行的话，每个字都成了单独的一行，换列时又并回前一行 —— 大字重影、多列挤成一列
    const vertical = cs.writingMode.startsWith("vertical");
    const lines = [];
    const range = document.createRange();
    // 作者写的换行（<br>、pre 里的回车）在 PowerPoint 里另起一段；排版折出来的行并回同一段
    let hard = false;
    let prev = null;
    for (const node of textBlocks.get(block)) {
      if (prev) {
        range.setStart(prev, prev.length);
        range.setEnd(node, 0);
        if (range.cloneContents().querySelector("br")) hard = true;
      }
      prev = node;
      const ecs = getComputedStyle(node.parentElement);
      const eo = opacityOf(node.parentElement);
      if (eo < 0.05) continue;
      const keepsNewlines = /^(pre|pre-wrap|pre-line|break-spaces)$/.test(ecs.whiteSpace);
      const fontSize = parseFloat(ecs.fontSize);
      const { font, ea } = fontOf(ecs);
      const style = {
        font,
        ea,
        size: fontSize,
        weight: parseInt(ecs.fontWeight, 10),
        bold: parseInt(ecs.fontWeight, 10) >= 600,
        italic: ecs.fontStyle === "italic",
        spacing: ecs.letterSpacing === "normal" ? 0 : parseFloat(ecs.letterSpacing) || 0,
        ...(withAlpha(rgba(ecs.color), eo) ?? { color: "000000", alpha: 0 }),
      };
      const clip = clipOf(node);
      if (clip) {
        const { grad } = textGradient(clip);
        style.grad = { ...grad, stops: grad.stops.map((s) => ({ ...s, alpha: s.alpha * eo })) };
        Object.assign(style, { color: grad.stops[0].color, alpha: eo });
      }
      const key = JSON.stringify(style);
      const chars = [...node.data];
      let at = 0;
      for (const ch of chars) {
        if (ch === "\n" && keepsNewlines) hard = true;
        range.setStart(node, at);
        range.setEnd(node, at + ch.length);
        at += ch.length;
        const r = [...range.getClientRects()].find((x) => x.width > 0 || x.height > 0);
        if (!r) continue; // 折叠掉的空白
        const top = r.top - origin.top;
        const left = r.left - origin.left;
        let line = lines.at(-1);
        if (!line || (vertical ? Math.abs(left - line.left) > fontSize * 0.6 : top > line.top + fontSize * 0.6)) {
          line = { top, left, runs: [], hard: !line || hard };
          lines.push(line);
          hard = false;
        }
        const text = /\s/.test(ch) ? " " : vertical ? (VERTICAL_PUNCT[ch] ?? ch) : transformText(ch, ecs);
        const last = line.runs.at(-1);
        if (last && last.key === key) last.text += text;
        else line.runs.push({ key, ...style, text });
      }
    }
    for (const line of lines) {
      // 行首行尾的空白是排版换行留下的，PowerPoint 里会变成可见的空格；记下来，并行时补回一个
      const first = line.runs[0];
      if (first) {
        line.spaceBefore = /^\s/.test(first.text);
        first.text = first.text.replace(/^\s+/, "");
      }
      const last = line.runs.at(-1);
      if (last) {
        line.spaceAfter = /\s$/.test(last.text);
        last.text = last.text.replace(/\s+$/, "");
      }
      line.runs = line.runs.filter((r) => r.text);
    }
    const kept = lines.filter((l) => l.runs.length);
    if (!kept.length) return null;
    // 一段 = 作者写的一段：折出来的行接回去，交给 PowerPoint 按框宽重新折（改字时后面的行跟着走）。
    // 竖排照旧一列一段
    const paras = [];
    for (const line of kept) {
      const para = paras.at(-1);
      if (!para || line.hard || vertical) {
        paras.push({ runs: line.runs.map((r) => ({ ...r })), lines: 1, spaceAfter: line.spaceAfter });
        continue;
      }
      if (para.spaceAfter || line.spaceBefore) para.runs.at(-1).text += " ";
      for (const r of line.runs) {
        const end = para.runs.at(-1);
        if (end.key === r.key) end.text += r.text;
        else para.runs.push({ ...r });
      }
      para.lines++;
      para.spaceAfter = line.spaceAfter;
    }
    if (paras.at(-1)) delete paras.at(-1).spaceAfter;
    const align = { center: "ctr", right: "r", end: "r", justify: "just" }[cs.textAlign] ?? "l";
    const lh = cs.lineHeight === "normal" ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight);
    return {
      align,
      lineHeight: lh,
      paras: paras.map((p) => ({ lines: p.lines, runs: p.runs.map(({ key, ...r }) => r) })),
      // 有段落折了行，才交给 PowerPoint 折；只有一行的（标题）不折，宽一点点也不会被挤成两行
      wrap: !vertical && paras.some((p) => p.lines > 1),
      ...(vertical ? { vertical: true } : {}),
    };
  }

  const padOf = (cs) => ({
    l: parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
    t: parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth),
    r: parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth),
    b: parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth),
  });

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
    const turn = turnOf(el);
    // 旋转的元素：盒子按没转的样子量（中心不变，尺寸取布局尺寸乘上一路的缩放），旋转写进 rot。
    // 转角连外层的一起算。外层转的（吊灯的灯身挂在转着的 .lamp-rig 里）截图时在它自己身上叠一个
    // 反向的转（undo），绕自己的中心转回去，中心不动
    // <svg> 没有 offsetWidth（斜贴在立体柱侧面的小图标），布局尺寸从算好的样式里取
    const own = rotationOf(cs);
    const lin = linearOf(el);
    const total = (Math.atan2(lin.b, lin.a) * 180) / Math.PI;
    const inherited = Math.abs(total - own) > 0.01 && Math.abs(total) > 0.01;
    const rot = inherited ? total : own;
    const lw = (el.offsetWidth ?? parseFloat(cs.width)) * (inherited ? Math.hypot(lin.a, lin.b) : 1);
    const lh = (el.offsetHeight ?? parseFloat(cs.height)) * (inherited ? Math.hypot(lin.c, lin.d) : 1);
    const geo = rot || turn
      ? { x: b.x + b.w / 2 - lw / 2, y: b.y + b.h / 2 - lh / 2, w: lw, h: lh }
      : b;
    const base = {
      identity, turn, label: label(el), selector: selectorOf(el), ...geo,
      ...(rot || turn ? { rot } : {}),
      ...(inherited ? { undo: `${cs.transform === "none" ? "" : cs.transform} rotate(${(own - total).toFixed(3)}deg)` } : {}),
    };

    const tag = el.tagName;
    if (RASTER_TAGS.has(tag) || el instanceof SVGSVGElement) {
      el.dataset.pptxK = String(k);
      items.push({ ...base, k: k++, kind: "raster", whole: true, reason: tag === "VIDEO" ? "视频导成静帧" : `<${tag.toLowerCase()}>` });
      skipInside.add(el);
      continue;
    }

    if (clipsText(el) && textGradient(el)) {
      // 渐变只铺在字上：自己不出色块，字在下面按文本框导（textOf 给字填渐变）
      if (textBlocks.has(el)) {
        const text = textOf(el, o);
        if (text) items.push({ ...base, kind: "box", geom: "rect", fill: null, line: null, text: { ...text, insets: padOf(cs) } });
      }
      continue;
    }
    if (clipsText(el)) {
      el.dataset.pptxK = String(k);
      items.push({ ...base, k: k++, kind: "raster", whole: true, reason: "渐变字" });
      skipInside.add(el);
      continue;
    }

    const reasons = [];
    const grad = cs.backgroundImage !== "none" ? gradientOf(cs, geo.w, geo.h, o) : null;
    if (cs.backgroundImage !== "none" && !grad) reasons.push("渐变或背景图");
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
    // 渐变铺在描边里面，PowerPoint 的填充铺满整个形状：带描边的照旧截图
    if (grad && bordered) reasons.push("渐变或背景图");

    // mask / clip-path 管的是整棵子树：孩子拆出去单独截，就截不到遮罩（文字镂空的色块淡出会丢，导成一块实心）。
    // 里面没有要导成文本框的字时整块截；有字的（片尾名单）照旧拆开，字还是字。
    // 被灯照亮的那一层（data-lit、.s-lit）有字也整块截：层里的字是页面上那份字的「亮」版，拆成文本框就没了遮罩，
    // 盖住页面上的字（stage-spotlight 的题目整行成了和底色一样的红字）
    const masks = reasons.includes("mask") || reasons.includes("clip-path");
    if (masks && (el.matches("[data-lit], .s-lit") || ![...textBlocks.keys()].some((block) => el.contains(block)))) {
      el.dataset.pptxK = String(k);
      items.push({ ...base, k: k++, kind: "raster", whole: true, reason: reasons.join("、") });
      skipInside.add(el);
      continue;
    }
    if (reasons.length) {
      // 自己的底色和装饰截成图，里面的孩子照常导（文字还是文字）
      el.dataset.pptxK = String(k);
      items.push({ ...base, k: k++, kind: "raster", whole: false, reason: reasons.join("、") });
    } else {
      const fill = grad ?? withAlpha(rgba(cs.backgroundColor), o);
      const line = bordered ? { ...withAlpha(rgba(sides[0].color), o), width: sides[0].width } : null;
      if (fill || (line && line.color)) {
        const radius = parseFloat(cs.borderTopLeftRadius) || 0;
        const radiusPx = cs.borderTopLeftRadius.endsWith("%") ? (radius / 100) * Math.min(geo.w, geo.h) : radius;
        const round = ovalOf(cs, geo.w, geo.h);
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
        if (box) box.text = { ...text, insets: padOf(cs) };
        else items.push({ ...base, kind: "box", geom: "rect", fill: null, line: null, text: { ...text, insets: padOf(cs) } });
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
    flip: q("[data-flip]"),
    text: q("[data-text]:not([data-roll])"),
    roll: q("[data-roll]"),
    // 被灯照亮的那一层：网页里光每一帧跟着灯重算，PPTX 里是每页截一张，平滑只能交叉淡化。和上一页共有才算（第二遍判）
    lit: [...section.querySelectorAll("[data-lit][data-id], .s-lit[data-id]")].map((el) => el.dataset.id),
    lost: [
      // 光束（data-light 写在 data-path 上）、照亮的层、进页开灯都是页内动画
      ...(q("[data-anim], [data-step], [data-path], [data-lit], .s-lamp[data-lamp-on]") ? ["anim"] : []),
      ...(q("video") ? ["video"] : []),
      ...(q("[data-auto-animate-delay]") ? ["rhythm"] : []),
    ],
  };
  return { background: background ?? { color: "ffffff" }, facts, items, origin: { x: origin.left, y: origin.top } };
}


// 嵌进 PPTX 的字体：skill 自带的网页字体，每个字重一个静态 .ttf（scripts/fetch-fonts.mjs 取的）
const FONT_DIR = new URL("../../runtime/fonts/pptx/", import.meta.url);
const FONTS = existsSync(new URL("fonts.json", FONT_DIR)) ? JSON.parse(readFileSync(new URL("fonts.json", FONT_DIR), "utf8")) : [];

/** CSS 里的家族名 + 字重 + 正斜 → 嵌哪个字体文件。没有这个家族返回 null（系统字体，不嵌） */
function embeddedFont(family, weight, italic) {
  const style = italic ? "italic" : "normal";
  const same = FONTS.filter((f) => f.family.toLowerCase() === family.toLowerCase());
  const pool = same.filter((f) => f.style === style).length ? same.filter((f) => f.style === style) : same;
  if (!pool.length) return null;
  return pool.reduce((best, f) => (Math.abs(f.weight - weight) < Math.abs(best.weight - weight) ? f : best));
}

// PowerPoint 认不出的系统字体 → Office 自带、Mac 和 Windows 都有的替身。PingFang 放在 macOS 按需下载的
// 资源目录里，Office 不扫那里，原样写进去会把中文换成微软雅黑、西文换成 Calibri（窄 14%，折行全变）。
// 微软雅黑的西文字宽和字身高跟 PingFang 最接近（宽差 3% 以内），中文本来就是一字一格
const SUBSTITUTES = {
  "PingFang SC": "Microsoft YaHei",
  "PingFang TC": "Microsoft JhengHei",
  "PingFang HK": "Microsoft JhengHei",
  "PingFang MO": "Microsoft JhengHei",
};

/**
 * 把字换成嵌进文件的字体：每个字重是一个单独的字体（「Inter SemiBold」），粗、斜按那个字体自己的档来，
 * 不让 PowerPoint 再加粗一遍；PowerPoint 认不出的换成替身。返回 { fonts, substituted }：
 * fonts 是 model.fonts（[{ typeface, regular?, bold?, italic?, boldItalic? }]，EOT），substituted 是 [{ from, to }]
 */
function embedFonts(slides) {
  const used = new Map();
  const substituted = new Map();
  const runs = slides.flatMap((s) =>
    s.shapes.flatMap((x) => (x.kind === "raster" || !x.text ? [] : x.text.paras.flatMap((p) => p.runs))),
  );
  for (const r of runs) {
    for (const key of ["font", "ea"]) {
      const to = SUBSTITUTES[r[key]];
      if (!to) continue;
      substituted.set(r[key], to);
      r[key] = to;
    }
    const font = embeddedFont(r.font, r.weight ?? (r.bold ? 700 : 400), r.italic);
    if (!font) continue;
    if (r.ea === r.font) r.ea = font.typeface;
    r.font = font.typeface;
    r.bold = /Bold/.test(font.subfamily);
    r.italic = /Italic/.test(font.subfamily);
    used.set(font.file, font);
  }
  const byFace = new Map();
  for (const font of used.values()) {
    const slot = { Regular: "regular", Bold: "bold", Italic: "italic", "Bold Italic": "boldItalic" }[font.subfamily] ?? "regular";
    if (!byFace.has(font.typeface)) byFace.set(font.typeface, { typeface: font.typeface });
    byFace.get(font.typeface)[slot] = eot(readFileSync(new URL(font.file, FONT_DIR)));
  }
  return { fonts: [...byFace.values()], substituted: [...substituted].map(([from, to]) => ({ from, to })) };
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
  const stored = new Map();
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
        // 外层转的（undo）看外接框：转回来了，外接框就是它自己的大小
        const left = await page.evaluate(({ sel, undo, w, h }) => {
          const el = document.querySelector(sel);
          if (undo) {
            const b = el.getBoundingClientRect();
            return Math.abs(b.width - w) < 1 && Math.abs(b.height - h) < 1 ? null : `外接框 ${b.width.toFixed(1)}×${b.height.toFixed(1)}`;
          }
          const cs = getComputedStyle(el);
          return cs.rotate === "none" || cs.rotate === "0deg" ? (cs.transform === "none" ? null : cs.transform) : cs.rotate;
        }, unrotated);
        if (left) throw new Error(`第 ${i + 1} 页 ${unrotated.sel} 截图前没转回 0°（还是 ${left}）`);
      }
      // 整块不透明的（照片、油画背景）存 JPG，小七八倍；带透明的留 PNG
      const png = await page.screenshot({ clip, transparent: true });
      const out = opaque(png) ? { data: await page.screenshot({ clip, quality: JPG_QUALITY }), ext: "jpg" } : { data: png, ext: "png" };
      await remove();
      return out;
    };
    // 内容一样的图只存一份，几页共用（同一张背景每页都截一次）
    const store = (base, { data, ext }) => {
      const hash = createHash("sha1").update(data).digest("hex");
      if (!stored.has(hash)) {
        stored.set(hash, `${base}.${ext}`);
        media.set(`${base}.${ext}`, data);
      }
      return stored.get(hash);
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
        (item.undo
          ? `${sel} { transform: ${item.undo} !important; transition: none !important; animation: none !important; }`
          : item.rot !== undefined
            ? `${sel} { rotate: none !important; transform: none !important; transition: none !important; animation: none !important; }`
            : "");
      const clip = { x: m.origin.x + item.x, y: m.origin.y + item.y, width: item.w, height: item.h };
      // 画外待命的元素（分层视差的封面页，各层压在画布下方一两千像素）可能出了视口，截不到。
      // 截图时临时挪进视口（独立的 translate 属性，叠在它自己的 transform 上），PPTX 里照旧写它在画外的位置
      const into = (at, size, view) => (at < 0 ? -at : at + size > view ? view - (at + size) : 0);
      const dx = into(clip.x, clip.width, VIEW.width);
      const dy = into(clip.y, clip.height, VIEW.height);
      const moved = dx || dy ? `${sel} { translate: ${dx}px ${dy}px !important; }` : "";
      clip.x += dx;
      clip.y += dy;
      const name = store(
        `s${i + 1}-${item.k}`,
        await shot(style + moved, clip, item.rot !== undefined ? { sel, undo: !!item.undo, w: item.w, h: item.h } : null),
      );
      shapes.push({ ...item, media: name });
      rasters.push({ name: item.label, identity: item.identity, reason: item.reason, selector: item.selector });
    }
    let background = m.background;
    if (background.raster) {
      const name = store(
        `s${i + 1}-bg`,
        await shot(".reveal .slides * { visibility: hidden !important; }", { x: m.origin.x, y: m.origin.y, width: W, height: H }),
      );
      background = { media: name };
    }
    slides.push({ measured: m, shapes, background, timing, rasters });
  }

  // 第二遍：配对和转场要看前后两页
  const { fonts, substituted } = embedFonts(slides);
  const model = { slides: [], media, fonts };
  // 哪页有几块，整份稿子里它每页都按 `!!键~标签` 起名：一页整块截成一张图（`!!q1`）、下一页拆成两块
  // （`!!q1~s-prism`、`!!q1~svg`），名字对不上，平滑配不起来，柱子成了淡出淡入
  const split = new Set();
  for (const s of slides) {
    const count = new Map();
    for (const { identity } of s.shapes) if (identity) count.set(identity, (count.get(identity) ?? 0) + 1);
    for (const [key, k] of count) if (k > 1) split.add(key);
  }
  slides.forEach((s, i) => {
    const prev = slides[i - 1];
    const ids = (sl) => new Set(sl.shapes.map((x) => x.identity).filter(Boolean));
    const shared = prev ? [...ids(s)].filter((id) => ids(prev).has(id)) : [];
    const facts = { ...s.measured.facts, shared, lit: s.measured.facts.lit.some((id) => shared.includes(id)), duration: Math.max(0.3, Math.min(3, s.timing.transition / 1000 || 1)) };
    const transition = i === 0 ? { kind: "none", technique: null, tier: "保真", elements: [] } : pageTransition(facts);

    // 共享元素的名字：只有一块就叫 `!!键`；几块的（哪页有几块就算）不收成组（组里的形状 PowerPoint 的平滑不按名字配，
    // 前后两页的吊灯成了一盏淡出、一盏淡入），每块单独叫 `!!键~标签`，同一个标签第二块起加 `-2`、`-3`
    const shapes = [];
    const named = [];
    const pieces = new Map();
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
                vertical: item.text.vertical,
                wrap: item.text.wrap,
                paras: item.text.paras.map((p) => ({ align: item.text.align, lineHeight: item.text.lineHeight, runs: p.runs })),
              },
            };
      // 没有键的形状名字里带页号：PowerPoint 不会因为名字一样把两页的它们配上
      shape.name = `s${i + 1} ${item.label} ${++n}`;
      if (item.identity) {
        if (!pieces.has(item.identity)) pieces.set(item.identity, []);
        pieces.get(item.identity).push({ shape, label: item.label });
      }
      shapes.push(shape);
      named.push({ shape, selector: item.selector });
    }
    for (const [key, list] of pieces) {
      if (list.length === 1 && !split.has(key)) {
        list[0].shape.name = `!!${key}`;
        continue;
      }
      const seen = new Map();
      for (const { shape, label } of list) {
        seen.set(label, (seen.get(label) ?? 0) + 1);
        shape.name = `!!${key}~${label}${seen.get(label) > 1 ? `-${seen.get(label)}` : ""}`;
      }
    }
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
      // 包里每个形状 ↔ 稿子里的元素
      shapes: named.map(({ shape, selector }) => ({ name: shape.name, selector })),
      texts: s.shapes.filter((x) => x.text).flatMap((x) => x.text.paras.map((p) => p.runs.map((r) => r.text).join(""))),
      lost,
    });
  });

  const title = await page.evaluate(() => document.title);
  const pptx = buildPptx(model, { title });
  // 嵌进文件的字体；fonts 只列没嵌的（系统字体、中文字体），看的那台电脑要装
  report.embeddedFonts = model.fonts.map((f) => f.typeface);
  report.substitutedFonts = substituted;
  const embedded = new Set(report.embeddedFonts);
  report.fonts = [
    ...new Set(slides.flatMap((s) => s.shapes.flatMap((x) => x.text?.paras.flatMap((p) => p.runs.flatMap((r) => [r.font, r.ea])) ?? []))),
  ].filter((f) => f && !embedded.has(f));
  report.degraded = report.slides
    .filter((s) => s.transition.tier !== "保真")
    .map((s) => ({ from: s.index - 1, to: s.index, technique: [s.transition.technique, ...s.transition.elements.filter((e) => e.tier !== "保真").map((e) => e.name)].filter(Boolean).join(" + "), tier: s.transition.tier, kind: s.transition.kind }));
  return { pptx, report, frames };
}
