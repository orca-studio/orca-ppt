// 读一份现成的 .pptx，整理成内容大纲：每页的文字（分段、层级、项目符号、字号字重颜色）、图片、
// 表格、图表数据和备注。给 agent 拿现成的 PPTX 当素材、重新做成网页稿用。纯函数，不碰浏览器和
// 文件系统，所以能单独测。
//
// 输出的是内容大纲，不是 pptx-write.mjs 的模型：那份是导出器量出来的几何，这份是从包里读回来的
// 内容。两边不互逆，读回来的东西不拿去再写 PPTX。
//
// 坐标和字号一律换算成画布像素：页宽按 1920 算，16:9 的页是 1920×1080，4:3 的是 1920×1440。
// 占位符从版式、母版继承来的位置和文字样式在这里解开；块按页里的叠放顺序（从下到上）排。
// 不收的：版式和母版上的装饰（logo、底纹），颜色的亮度微调（lumMod 之类），一段里第一段字以外的样式。
//
// 大纲：
//   { title?, size: { w, h }, slides: [页…], media: Map<文件名, Buffer> }
//   页：    { index, hidden, layout?, background, title?, blocks: [块…], notes? }
//           background：{ color } | { media } | { kind: "gradient" | "pattern" } | null
//   文字：  { kind: "text", name, role?, box, rot?, paragraphs: [{ text, level, bullet?, size?, bold?, italic?, color?, font? }] }
//           role 是占位符的角色：title / subtitle / body / date / footer / number；普通文本框没有
//           一段里的换行（<a:br>）是 text 里的 "\n"
//   图片：  { kind: "image", name, box, rot?, media, descr?, video? }   video：这张是视频的封面
//   表格：  { kind: "table", name, box, rows: [[格子的文字…]…] }   合并掉的格子是 ""
//   图表：  { kind: "chart", name, box, type, title?, categories, series: [{ name?, values }] }
//   图示：  { kind: "diagram", name, box, texts }   SmartArt，只取文字
//   形状：  { kind: "shape", name, box, rot?, geom, fill? }   不带字的形状和连接线
//   对象：  { kind: "object", name, box, progId? }   嵌入的 OLE 对象
//   box：{ x, y, w, h }
import path from "node:path";
import { readZip } from "./zip.mjs";
import { parseXml, findAll, find, child } from "./xml.mjs";

const CANVAS_W = 1920;
const EMU_PER_PT = 12700;

/** 顺着子元素名一层层往下走，哪层没有就是 undefined */
const at = (el, ...names) => names.reduce((e, n) => e && child(e, n), el);
const on = (v) => v === "1" || v === "true";

function openPackage(buffer) {
  const files = readZip(buffer);
  const parsed = new Map();
  const xml = (name) => {
    if (!name || !files.has(name)) return null;
    if (!parsed.has(name)) parsed.set(name, parseXml(files.get(name).toString("utf8")));
    return parsed.get(name);
  };
  /** 部件的关系：Map<rId, { type, target }>。type 取关系类型的最后一节，target 是包里的部件名；外部链接不收 */
  const rels = (part) => {
    const dir = path.posix.dirname(part);
    const root = xml(`${dir === "." ? "" : dir + "/"}_rels/${path.posix.basename(part)}.rels`);
    const out = new Map();
    for (const r of root ? findAll(root, "Relationship") : []) {
      if (r.attrs.TargetMode === "External") continue;
      const t = r.attrs.Target;
      const target = t.startsWith("/") ? t.slice(1) : path.posix.normalize(path.posix.join(dir, t));
      out.set(r.attrs.Id, { type: r.attrs.Type.split("/").pop(), target });
    }
    return out;
  };
  const relOfType = (part, type) => [...rels(part).values()].find((r) => r.type === type)?.target;
  return { files, xml, rels, relOfType };
}

// ── 颜色和字体

const PRESET_COLORS = { black: "000000", white: "ffffff", red: "ff0000", green: "008000", blue: "0000ff", yellow: "ffff00", gray: "808080" };

/** 母版的主题：配色、母版的颜色映射（tx1 → dk1 这种）、主题字体 */
function themeOf(pkg, masterPart, master) {
  const theme = pkg.xml(pkg.relOfType(masterPart, "theme"));
  const colors = {};
  for (const c of (theme && find(theme, "a:clrScheme")?.children) ?? []) {
    const v = child(c, "a:srgbClr")?.attrs.val ?? child(c, "a:sysClr")?.attrs.lastClr;
    if (v) colors[c.name.slice(2)] = v;
  }
  const fonts = theme && find(theme, "a:fontScheme");
  const face = (kind, script) => at(fonts, `a:${kind}Font`, `a:${script}`)?.attrs.typeface || undefined;
  return {
    colors,
    clrMap: find(master, "p:clrMap")?.attrs ?? {},
    fonts: { "+mj-lt": face("major", "latin"), "+mn-lt": face("minor", "latin"), "+mj-ea": face("major", "ea"), "+mn-ea": face("minor", "ea") },
  };
}

/** a:solidFill 这类填充元素 → "#rrggbb" */
function colorOf(fill, theme) {
  const c = fill?.children.find((e) => ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr"].includes(e.name));
  if (!c) return undefined;
  const hex =
    c.name === "a:srgbClr"
      ? c.attrs.val
      : c.name === "a:sysClr"
        ? c.attrs.lastClr
        : c.name === "a:prstClr"
          ? PRESET_COLORS[c.attrs.val]
          : theme.colors[theme.clrMap[c.attrs.val] ?? c.attrs.val];
  return hex ? "#" + hex.toLowerCase() : undefined;
}

/** a:rPr / a:defRPr 上写了的文字样式。size 是 pt，最后再换成画布像素 */
function runProps(r, theme) {
  const p = {};
  if (!r) return p;
  if (r.attrs.sz) p.size = +r.attrs.sz / 100;
  if (r.attrs.b) p.bold = on(r.attrs.b);
  if (r.attrs.i) p.italic = on(r.attrs.i);
  const color = colorOf(child(r, "a:solidFill"), theme);
  if (color) p.color = color;
  const face = child(r, "a:latin")?.attrs.typeface || child(r, "a:ea")?.attrs.typeface;
  if (face) p.font = face.startsWith("+") ? theme.fonts[face] : face;
  return p;
}

/** 项目符号：后写的盖前面的；buNone 关掉 */
function bulletOf(pPr, current) {
  if (!pPr) return current;
  if (child(pPr, "a:buNone")) return undefined;
  if (child(pPr, "a:buChar")) return child(pPr, "a:buChar").attrs.char;
  if (child(pPr, "a:buAutoNum")) return "1.";
  return current;
}

// ── 占位符

const nvOf = (el) => el.children.find((c) => c.name.startsWith("p:nv"));
const phOf = (el) => at(nvOf(el), "p:nvPr", "p:ph");
const phType = (ph) => ({ ctrTitle: "title", obj: "body" })[ph.attrs.type] ?? ph.attrs.type ?? "body";
const ROLES = { title: "title", subTitle: "subtitle", body: "body", dt: "date", ftr: "footer", sldNum: "number" };

/** 在版式 / 母版里找对应的占位符：版式先按 idx 配，再按类型；母版只按类型（副标题配正文） */
function matchPh(tree, ph, onMaster) {
  if (!tree) return undefined;
  const all = findAll(tree, "p:sp").filter((sp) => phOf(sp));
  const want = onMaster && phType(ph) === "subTitle" ? "body" : phType(ph);
  return (
    (!onMaster && ph.attrs.idx !== undefined && all.find((sp) => phOf(sp).attrs.idx === ph.attrs.idx)) ||
    all.find((sp) => phType(phOf(sp)) === want)
  );
}

// ── 位置

const xfrmOf = (el) => at(el, "p:spPr", "a:xfrm") ?? at(el, "p:grpSpPr", "a:xfrm") ?? child(el, "p:xfrm");

/** 组里的坐标换成外层的：子坐标系（chOff / chExt）映到组的框（off / ext） */
function groupTransform(grp, outer) {
  const x = xfrmOf(grp);
  const [off, ext, chOff, chExt] = ["a:off", "a:ext", "a:chOff", "a:chExt"].map((n) => child(x ?? { children: [] }, n)?.attrs);
  if (!off || !ext || !chOff || !chExt) return outer;
  const sx = +chExt.cx ? +ext.cx / +chExt.cx : 1;
  const sy = +chExt.cy ? +ext.cy / +chExt.cy : 1;
  return (b) => outer({ x: +off.x + (b.x - +chOff.x) * sx, y: +off.y + (b.y - +chOff.y) * sy, w: b.w * sx, h: b.h * sy });
}

// ── 页里的东西

/** txBody 的每段 → 段落（空段不要）。sources 是从远到近的列表样式：默认样式、母版、版式、形状自己的 */
function paragraphsOf(body, sources, ctx) {
  const out = [];
  for (const p of body ? findAll(body, "a:p") : []) {
    const pPr = child(p, "a:pPr");
    const level = +(pPr?.attrs.lvl ?? 0);
    let text = "";
    let firstRun;
    for (const c of p.children) {
      if (c.name === "a:r" || c.name === "a:fld") {
        const t = child(c, "a:t")?.text ?? "";
        text += t;
        if (t.trim() && !firstRun) firstRun = child(c, "a:rPr");
      } else if (c.name === "a:br") text += "\n";
    }
    if (!text.trim()) continue;
    const levels = [...sources.map((s) => at(s, `a:lvl${level + 1}pPr`)), pPr];
    const style = Object.assign({}, ...levels.map((l) => runProps(child(l ?? { children: [] }, "a:defRPr"), ctx.theme)), runProps(firstRun, ctx.theme));
    const bullet = levels.reduce((b, l) => bulletOf(l, b), undefined);
    const para = { text, level };
    if (bullet) para.bullet = bullet;
    if (style.size) para.size = round(style.size * EMU_PER_PT * ctx.scale, 1);
    for (const k of ["bold", "italic", "color", "font"]) if (style[k]) para[k] = style[k];
    out.push(para);
  }
  return out;
}

const plainText = (body) =>
  (body ? findAll(body, "a:p") : [])
    .map((p) => findAll(p, "a:t").map((t) => t.text).join(""))
    .filter((t) => t.trim())
    .join("\n");

/** 一个形状 → 块；空占位符和认不出的元素返回 null */
function blockOf(el, ctx, tf) {
  if (!["p:sp", "p:cxnSp", "p:pic", "p:graphicFrame"].includes(el.name)) return null;
  const nv = nvOf(el);
  const cNvPr = child(nv ?? { children: [] }, "p:cNvPr");
  if (!cNvPr) return null;
  const name = cNvPr.attrs.name ?? "";
  const ph = phOf(el);
  const layoutPh = ph && matchPh(ctx.layoutTree, ph, false);
  const masterPh = ph && matchPh(ctx.masterTree, ph, true);
  const xfrm = xfrmOf(el) ?? (layoutPh && xfrmOf(layoutPh)) ?? (masterPh && xfrmOf(masterPh));
  const off = xfrm && child(xfrm, "a:off")?.attrs;
  const ext = xfrm && child(xfrm, "a:ext")?.attrs;
  const emuBox = off && ext ? tf({ x: +off.x, y: +off.y, w: +ext.cx, h: +ext.cy }) : null;
  const box = emuBox && Object.fromEntries(Object.entries(emuBox).map(([k, v]) => [k, Math.round(v * ctx.scale)]));
  const base = { name, box };
  if (xfrm?.attrs.rot && +xfrm.attrs.rot) base.rot = round(+xfrm.attrs.rot / 60000, 1);

  if (el.name === "p:sp") {
    const role = ph && (ROLES[phType(ph)] ?? phType(ph));
    const masterStyle = ["title", "subtitle", "body"].includes(role)
      ? at(ctx.master, "p:txStyles", role === "title" ? "p:titleStyle" : "p:bodyStyle")
      : at(ctx.master, "p:txStyles", "p:otherStyle");
    const sources = [ctx.defaultTextStyle, masterStyle, ...[masterPh, layoutPh, el].map((s) => s && at(s, "p:txBody", "a:lstStyle"))];
    const paragraphs = paragraphsOf(child(el, "p:txBody"), sources, ctx);
    if (paragraphs.length) return { kind: "text", ...base, ...(role ? { role } : {}), paragraphs };
    if (ph) return null;
    const spPr = child(el, "p:spPr");
    const geom = at(spPr, "a:prstGeom")?.attrs.prst ?? (at(spPr, "a:custGeom") ? "custom" : "rect");
    const fill = colorOf(at(spPr, "a:solidFill"), ctx.theme);
    return { kind: "shape", ...base, geom, ...(fill ? { fill } : {}) };
  }
  if (el.name === "p:cxnSp") return { kind: "shape", ...base, geom: at(child(el, "p:spPr"), "a:prstGeom")?.attrs.prst ?? "line" };
  if (el.name === "p:pic") {
    const target = ctx.rels.get(find(el, "a:blip")?.attrs["r:embed"])?.target;
    if (!target) return null;
    const image = { kind: "image", ...base, media: ctx.addMedia(target) };
    if (cNvPr.attrs.descr) image.descr = cNvPr.attrs.descr;
    if (find(nv, "a:videoFile")) image.video = true;
    return image;
  }
  if (el.name === "p:graphicFrame") {
    const data = find(el, "a:graphicData");
    const table = data && find(data, "a:tbl");
    if (table) {
      const rows = findAll(table, "a:tr").map((tr) =>
        tr.children.filter((c) => c.name === "a:tc").map((tc) => (on(tc.attrs.hMerge) || on(tc.attrs.vMerge) ? "" : plainText(child(tc, "a:txBody")))),
      );
      return { kind: "table", ...base, rows };
    }
    const chart = data && find(data, "c:chart");
    if (chart) return { kind: "chart", ...base, ...chartOf(ctx.pkg, ctx.rels.get(chart.attrs["r:id"])?.target) };
    const diagram = data && find(data, "dgm:relIds");
    if (diagram) {
      const part = ctx.pkg.xml(ctx.rels.get(diagram.attrs["r:dm"])?.target);
      return { kind: "diagram", ...base, texts: part ? findAll(part, "a:t").map((t) => t.text).filter((t) => t.trim()) : [] };
    }
    const ole = data && find(data, "p:oleObj");
    return { kind: "object", ...base, ...(ole?.attrs.progId ? { progId: ole.attrs.progId } : {}) };
  }
  return null;
}

function walk(tree, ctx, tf, out) {
  for (const el of tree.children) {
    if (el.name === "mc:AlternateContent") {
      const pick = child(el, "mc:Choice") ?? child(el, "mc:Fallback");
      if (pick) walk(pick, ctx, tf, out);
    } else if (el.name === "p:grpSp") walk(el, ctx, groupTransform(el, tf), out);
    else {
      const block = blockOf(el, ctx, tf);
      if (block) out.push(block);
    }
  }
  return out;
}

/** 缓存里的一列值：strRef / numRef 读缓存，strLit / numLit 直接是值，多层分类取最里一层 */
function cachedValues(el) {
  if (!el) return [];
  const multi = find(el, "c:multiLvlStrCache");
  const cache = multi ? child(multi, "c:lvl") : (find(el, "c:strCache") ?? find(el, "c:numCache") ?? find(el, "c:strLit") ?? find(el, "c:numLit"));
  if (!cache) return [];
  const out = Array.from({ length: +(child(cache, "c:ptCount")?.attrs.val ?? 0) }, () => null);
  for (const pt of cache.children.filter((c) => c.name === "c:pt")) out[+pt.attrs.idx] = child(pt, "c:v")?.text ?? null;
  return out;
}

function chartOf(pkg, part) {
  const doc = pkg.xml(part);
  const chart = doc && find(doc, "c:chart");
  if (!chart) return { type: "unknown", categories: [], series: [] };
  const groups = (child(chart, "c:plotArea")?.children ?? []).filter((c) => /^c:\w+Chart$/.test(c.name));
  const typeOf = (g) => (g.name === "c:barChart" && at(g, "c:barDir")?.attrs.val === "col" ? "column" : g.name.slice(2, -5));
  const series = groups.flatMap((g) => g.children.filter((c) => c.name === "c:ser"));
  const num = (v) => (v === null || v === "" || isNaN(+v) ? v : +v);
  const title = child(chart, "c:title") && findAll(child(chart, "c:title"), "a:t").map((t) => t.text).join("");
  return {
    type: [...new Set(groups.map(typeOf))].join("+") || "unknown",
    ...(title ? { title } : {}),
    categories: cachedValues(series[0] && (child(series[0], "c:cat") ?? child(series[0], "c:xVal"))).map(num),
    series: series.map((s) => {
      const tx = child(s, "c:tx");
      const name = tx && (child(tx, "c:v")?.text ?? cachedValues(tx)[0]);
      return { ...(name ? { name } : {}), values: cachedValues(child(s, "c:val") ?? child(s, "c:yVal")).map(num) };
    }),
  };
}

/** 背景：页自己的，没有就版式的，再没有就母版的 */
function backgroundOf(chain, ctx) {
  for (const { doc, part } of chain) {
    const bg = doc && at(find(doc, "p:cSld"), "p:bg");
    if (!bg) continue;
    const pr = child(bg, "p:bgPr");
    const ref = child(bg, "p:bgRef");
    if (pr && child(pr, "a:solidFill")) return { color: colorOf(child(pr, "a:solidFill"), ctx.theme) };
    if (pr && child(pr, "a:blipFill")) {
      const target = ctx.pkg.rels(part).get(find(pr, "a:blip")?.attrs["r:embed"])?.target;
      return target ? { media: ctx.addMedia(target) } : null;
    }
    if (pr && child(pr, "a:gradFill")) return { kind: "gradient" };
    if (pr && child(pr, "a:pattFill")) return { kind: "pattern" };
    if (ref) return { color: colorOf(ref, ctx.theme) };
  }
  return null;
}

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/** buffer（.pptx 的内容）→ 大纲 */
export function readPptx(buffer) {
  const pkg = openPackage(buffer);
  const presPart = pkg.relOfType("", "officeDocument");
  const pres = pkg.xml(presPart);
  if (!pres || !find(pres, "p:presentation")) throw new Error("不是 PowerPoint 文件：找不到 presentation.xml");
  const sldSz = find(pres, "p:sldSz")?.attrs ?? { cx: 12192000, cy: 6858000 };
  const scale = CANVAS_W / +sldSz.cx;
  const presRels = pkg.rels(presPart);

  const media = new Map();
  const mediaNames = new Map();
  /** 包里的媒体部件 → 大纲里的文件名。不同目录里重名的加序号 */
  const addMedia = (target) => {
    if (!mediaNames.has(target)) {
      let name = path.posix.basename(target);
      for (let k = 2; media.has(name); k++) name = path.posix.basename(target).replace(/(\.\w+)?$/, `-${k}$1`);
      mediaNames.set(target, name);
      media.set(name, pkg.files.get(target));
    }
    return mediaNames.get(target);
  };

  const slideParts = findAll(pres, "p:sldId").map((s) => presRels.get(s.attrs["r:id"])?.target).filter((t) => t && pkg.files.has(t));
  const slides = slideParts.map((part, i) => {
    const doc = pkg.xml(part);
    const layoutPart = pkg.relOfType(part, "slideLayout");
    const layout = pkg.xml(layoutPart);
    const masterPart = layoutPart && pkg.relOfType(layoutPart, "slideMaster");
    const master = pkg.xml(masterPart);
    const ctx = {
      pkg,
      scale,
      rels: pkg.rels(part),
      addMedia,
      master,
      layoutTree: layout && find(layout, "p:spTree"),
      masterTree: master && find(master, "p:spTree"),
      defaultTextStyle: find(pres, "p:defaultTextStyle"),
      theme: master ? themeOf(pkg, masterPart, master) : { colors: {}, clrMap: {}, fonts: {} },
    };
    const blocks = walk(find(doc, "p:spTree"), ctx, (b) => b, []);
    const titleBlock = blocks.find((b) => b.role === "title");
    const notesDoc = pkg.xml(pkg.relOfType(part, "notesSlide"));
    const notes =
      notesDoc &&
      findAll(notesDoc, "p:sp")
        .filter((sp) => phOf(sp) && phType(phOf(sp)) === "body")
        .map((sp) => plainText(child(sp, "p:txBody")))
        .join("\n")
        .trim();
    const slide = {
      index: i + 1,
      hidden: doc.attrs.show === "0" || doc.attrs.show === "false",
      background: backgroundOf(
        [
          { doc, part },
          { doc: layout, part: layoutPart },
          { doc: master, part: masterPart },
        ],
        ctx,
      ),
      blocks,
    };
    const layoutName = layout && find(layout, "p:cSld")?.attrs.name;
    if (layoutName) slide.layout = layoutName;
    if (titleBlock) slide.title = titleBlock.paragraphs.map((p) => p.text).join(" ");
    if (notes) slide.notes = notes;
    return slide;
  });

  const core = pkg.xml(pkg.relOfType("", "core-properties"));
  const title = core && find(core, "dc:title")?.text.trim();
  return { ...(title ? { title } : {}), size: { w: CANVAS_W, h: Math.round(+sldSz.cy * scale) }, slides, media };
}

// ── 大纲 → Markdown，给 agent 读

const ROLE_LABELS = { title: "标题", subtitle: "副标题", body: "正文", date: "日期", footer: "页脚", number: "页码" };
const boxText = (b) => (b.box ? `${b.box.x},${b.box.y} ${b.box.w}×${b.box.h}` : "位置未知") + (b.rot ? ` 转 ${b.rot}°` : "");
const styleText = (p) => [p.size && `${p.size}px`, p.bold && "粗", p.italic && "斜", p.color, p.font].filter(Boolean).join(" ");
const inline = (s) => String(s).replace(/\n/g, "<br>");
const cell = (s) => inline(s).replace(/\|/g, "\\|");

function blockLines(b) {
  const meta = (extra) => "  `" + [boxText(b), extra].filter(Boolean).join(" · ") + "`";
  if (b.kind === "text") {
    const label = b.role ? `**${ROLE_LABELS[b.role] ?? b.role}** ` : "";
    const para = (p) => (p.bullet ? `${p.bullet} ` : "") + inline(p.text);
    if (b.paragraphs.length === 1) return [`- ${label}${para(b.paragraphs[0])}${meta(styleText(b.paragraphs[0]))}`];
    const lines = [`- ${label || "文字"}${meta()}`];
    let last;
    for (const p of b.paragraphs) {
      const style = styleText(p);
      lines.push(`${"  ".repeat(p.level + 1)}- ${para(p)}${style && style !== last ? "  `" + style + "`" : ""}`);
      last = style;
    }
    return lines;
  }
  if (b.kind === "image") return [`- 图片 media/${b.media}${b.video ? "（视频的封面）" : ""}${b.descr ? `：${inline(b.descr)}` : ""}${meta()}`];
  if (b.kind === "table") {
    const width = Math.max(...b.rows.map((r) => r.length));
    const row = (r) => "  | " + Array.from({ length: width }, (_, k) => cell(r[k] ?? "")).join(" | ") + " |";
    return [`- 表格${meta()}`, ...(b.rows.length ? [row(b.rows[0]), "  |" + " --- |".repeat(width), ...b.rows.slice(1).map(row)] : [])];
  }
  if (b.kind === "chart") {
    const list = (vs) => vs.map((v) => (v === null ? "—" : v)).join("、");
    return [
      `- 图表（${b.type}）${b.title ? inline(b.title) : ""}${meta()}`,
      ...(b.categories.length ? [`  - 分类：${list(b.categories)}`] : []),
      ...b.series.map((s, k) => `  - ${s.name ?? `系列 ${k + 1}`}：${list(s.values)}`),
    ];
  }
  if (b.kind === "diagram") return [`- 图示（SmartArt）：${b.texts.map(inline).join("、")}${meta()}`];
  if (b.kind === "object") return [`- 嵌入对象 ${b.progId ?? ""}${meta()}`];
  return [];
}

/** 大纲 → Markdown。不带字的形状只数个数，位置和颜色在 JSON 里 */
export function outlineMarkdown(deck) {
  const lines = [`# ${deck.title ?? "（没有标题）"}`, "", `${deck.slides.length} 页，画布 ${deck.size.w}×${deck.size.h}。坐标（x,y 宽×高）和字号都是画布像素，图片在 media/。`];
  for (const s of deck.slides) {
    lines.push("", `## 第 ${s.index} 页${s.title ? `：${inline(s.title)}` : ""}${s.hidden ? "（隐藏）" : ""}`);
    const bg = s.background && (s.background.color ?? (s.background.media ? `图片 media/${s.background.media}` : { gradient: "渐变", pattern: "图案" }[s.background.kind]));
    const facts = [s.layout && `版式「${s.layout}」`, bg && `背景 ${bg}`].filter(Boolean);
    if (facts.length) lines.push("", facts.join("，"));
    lines.push("");
    for (const b of s.blocks) lines.push(...blockLines(b));
    const shapes = s.blocks.filter((b) => b.kind === "shape").length;
    if (shapes) lines.push(`- 另有 ${shapes} 个不带字的形状（色块、线条）`);
    if (s.notes) lines.push("", "> 备注：", ...s.notes.split("\n").map((l) => `> ${l}`));
  }
  return lines.join("\n") + "\n";
}
