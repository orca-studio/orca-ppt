// 把 export-pptx.mjs 量出来的模型写成 .pptx 的各个部件。纯函数，不碰浏览器和文件系统，
// 所以能单独测。
//
// 坐标一律用画布像素（1920×1080）。PowerPoint 16:9 的页是 13.333 英寸宽，
// 1px = 12192000 / 1920 = 6350 EMU = 0.5pt。
//
// 模型：
//   { slides: [{ background: { color } | { media }, transition, shapes: [形状…] }], media: Map<名字, Buffer> }
//   形状 sp： { type: "sp", name, x, y, w, h, rot?, geom, radius?, fill?, line?, text? }
//   形状 pic：{ type: "pic", name, x, y, w, h, rot?, media }
//   形状 grp：{ type: "grp", name, children: [形状…] }
//   transition：{ kind: "morph" | "fade" | "wipe" | "none", duration?, dir? }
import { writeZip } from "./zip.mjs";

export const EMU_PER_PX = 6350;
const SLIDE_W = 1920 * EMU_PER_PX;
const SLIDE_H = 1080 * EMU_PER_PX;

const emu = (px) => Math.round(px * EMU_PER_PX);
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 不许出现的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** color: "rrggbb"，alpha: 0~1 */
function solid({ color, alpha = 1 }) {
  const a = alpha < 0.999 ? `<a:alpha val="${Math.round(alpha * 100000)}"/>` : "";
  return `<a:solidFill><a:srgbClr val="${color}">${a}</a:srgbClr></a:solidFill>`;
}

// PowerPoint 在两个色标之间不按 sRGB 插值，中段偏亮（蓝到紫中间发白、橙到紫中间发粉）。
// 每段按浏览器的算法（sRGB、透明度预乘）补几个中间色标，PowerPoint 只在很近的两点间插，差别看不出来
const DENSE = 8;
function densify(input) {
  // 全透明的色标颜色取相邻的：PowerPoint 不预乘，透明黑会在边上晕出一圈灰
  const stops = input.map((s, i) => {
    if (s.alpha > 0) return s;
    const near = input[i - 1]?.alpha > 0 ? input[i - 1] : input[i + 1]?.alpha > 0 ? input[i + 1] : s;
    return { ...s, color: near.color };
  });
  const rgb = (c) => [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  const hex = (v) => v.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");
  const out = [stops[0]];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (b.pos - a.pos > 0.001 && a.color !== b.color) {
      const [ca, cb] = [rgb(a.color), rgb(b.color)];
      for (let k = 1; k < DENSE; k++) {
        const t = k / DENSE;
        const alpha = a.alpha + (b.alpha - a.alpha) * t;
        // 预乘透明度插值：一头透明时颜色取另一头的，不会混进透明那头的黑
        const mix = ca.map((x, j) => (x * a.alpha * (1 - t) + cb[j] * b.alpha * t) / (alpha || 1));
        out.push({ pos: a.pos + (b.pos - a.pos) * t, color: hex(mix), alpha });
      }
    }
    out.push(b);
  }
  return out;
}

/**
 * 填充：纯色 { color, alpha }，或渐变
 * { grad: { type: "linear" | "radial", angle, path?: "circle" | "shape", stops: [{ pos: 0~1, color, alpha }] } }
 */
function fillXml(f) {
  if (!f.grad) return solid(f);
  const { type, angle, path, stops } = f.grad;
  const gs = densify(stops)
    .map((s) => {
      const a = s.alpha < 0.999 ? `<a:alpha val="${Math.round(s.alpha * 100000)}"/>` : "";
      return `<a:gs pos="${Math.round(s.pos * 100000)}"><a:srgbClr val="${s.color}">${a}</a:srgbClr></a:gs>`;
    })
    .join("");
  // 径向从正中往外。circle：正圆，外框的四个角是 100%；shape：沿形状的边，边上是 100%
  const shade =
    type === "radial"
      ? `<a:path path="${path || "circle"}"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>`
      : `<a:lin ang="${Math.round(angle * 60000) % 21600000}" scaled="0"/>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst>${shade}</a:gradFill>`;
}

function xfrm(s, tag = "a:xfrm") {
  // 绕圆心转的元素每页都写 rot，0° 也写（transitions.md「导出 PPTX」）
  const rot = s.rot !== undefined ? ` rot="${Math.round(s.rot * 60000)}"` : "";
  return `<${tag}${rot}><a:off x="${emu(s.x)}" y="${emu(s.y)}"/><a:ext cx="${Math.max(1, emu(s.w))}" cy="${Math.max(1, emu(s.h))}"/></${tag}>`;
}

function geometry(s) {
  if (s.geom === "roundRect") {
    // adj = 圆角半径 / 短边，上限 0.5
    const adj = Math.round(Math.min(0.5, s.radius / Math.max(1, Math.min(s.w, s.h))) * 100000);
    return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
  }
  return `<a:prstGeom prst="${s.geom || "rect"}"><a:avLst/></a:prstGeom>`;
}

function run(r) {
  const attrs = [`lang="${r.lang || "zh-CN"}"`, `sz="${Math.round(r.size * 50)}"`];
  if (r.bold) attrs.push('b="1"');
  if (r.italic) attrs.push('i="1"');
  if (r.spacing) attrs.push(`spc="${Math.round(r.spacing * 50)}"`);
  attrs.push('dirty="0"');
  const font = esc(r.font);
  const ea = esc(r.ea || r.font);
  return (
    `<a:r><a:rPr ${attrs.join(" ")}>${r.grad ? fillXml(r) : solid(r)}` +
    `<a:latin typeface="${font}"/><a:ea typeface="${ea}"/><a:cs typeface="${font}"/></a:rPr>` +
    `<a:t>${esc(r.text)}</a:t></a:r>`
  );
}

function textBody(t) {
  const ins = t.insets;
  // wrap="square"：一段是作者写的一段，PowerPoint 按框宽折行，改字时后面的行跟着走；
  // 只有单行的框写 wrap="none"，字体量得宽一点也不会被挤成两行
  // 竖排：eaVert 让一段成一列、从右往左排（和 writing-mode: vertical-rl 一样），标点自动换成竖排的写法
  const vert = t.vertical ? ' vert="eaVert"' : "";
  const body = `<a:bodyPr${vert} wrap="${t.wrap ? "square" : "none"}" lIns="${emu(ins.l)}" tIns="${emu(ins.t)}" rIns="${emu(ins.r)}" bIns="${emu(ins.b)}" anchor="t" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>`;
  const paras = t.paras
    .map((p) => {
      const ppr = `<a:pPr algn="${p.align || "l"}"><a:lnSpc><a:spcPts val="${Math.round(p.lineHeight * 50)}"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:buNone/></a:pPr>`;
      const end = p.runs[0] ? `<a:endParaRPr lang="zh-CN" sz="${Math.round(p.runs[0].size * 50)}" dirty="0"/>` : "";
      return `<a:p>${ppr}${p.runs.map(run).join("")}${end}</a:p>`;
    })
    .join("");
  return `<p:txBody>${body}${paras}</p:txBody>`;
}

function shapeXml(s, ctx) {
  const id = ctx.nextId++;
  const name = esc(s.name || `shape ${id}`);
  if (s.type === "grp") {
    const kids = s.children.map((c) => shapeXml(c, ctx)).join("");
    // 组的坐标系和页一样（chOff = off，chExt = ext），孩子不用换算
    const b = bounds(s.children);
    const g = `<a:xfrm><a:off x="${emu(b.x)}" y="${emu(b.y)}"/><a:ext cx="${emu(b.w)}" cy="${emu(b.h)}"/><a:chOff x="${emu(b.x)}" y="${emu(b.y)}"/><a:chExt cx="${emu(b.w)}" cy="${emu(b.h)}"/></a:xfrm>`;
    return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${g}</p:grpSpPr>${kids}</p:grpSp>`;
  }
  if (s.type === "pic") {
    const rid = ctx.rel(s.media);
    return (
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrm(s)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
    );
  }
  const fill = s.fill ? fillXml(s.fill) : "<a:noFill/>";
  const line = s.line ? `<a:ln w="${emu(s.line.width)}">${solid(s.line)}</a:ln>` : "<a:ln><a:noFill/></a:ln>";
  const txBox = s.text && !s.fill && !s.line ? ' txBox="1"' : "";
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${txBox}/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(s)}${geometry(s)}${fill}${line}</p:spPr>` +
    (s.text ? textBody(s.text) : "") +
    `</p:sp>`
  );
}

function bounds(shapes) {
  const flat = shapes.flatMap((s) => (s.type === "grp" ? [bounds(s.children)] : [s]));
  const x = Math.min(...flat.map((s) => s.x));
  const y = Math.min(...flat.map((s) => s.y));
  const r = Math.max(...flat.map((s) => s.x + s.w));
  const b = Math.max(...flat.map((s) => s.y + s.h));
  return { x, y, w: r - x, h: b - y };
}

/** 转场：平滑要 PowerPoint 2019 以上，旧版本退成淡入淡出（mc:Fallback）。 */
export function transitionXml(t) {
  if (!t || t.kind === "none") return "";
  const ms = Math.round((t.duration ?? 1) * 1000);
  if (t.kind === "morph") {
    return (
      `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
      `<mc:Choice xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p159">` +
      `<p:transition spd="slow" p14:dur="${ms}"><p159:morph option="byObject"/></p:transition></mc:Choice>` +
      `<mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`
    );
  }
  const effect = t.kind === "wipe" ? `<p:wipe dir="${t.dir || "r"}"/>` : "<p:fade/>";
  return (
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">` +
    `<p:transition spd="med" p14:dur="${ms}">${effect}</p:transition></mc:Choice>` +
    `<mc:Fallback><p:transition spd="med">${effect}</p:transition></mc:Fallback></mc:AlternateContent>`
  );
}

function slideXml(slide, rel) {
  const ctx = { nextId: 2, rel };
  const bg = slide.background?.media
    ? `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${rel(slide.background.media)}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`
    : `<p:bg><p:bgPr>${solid({ color: slide.background?.color || "ffffff" })}<a:effectLst/></p:bgPr></p:bg>`;
  const shapes = slide.shapes.map((s) => shapeXml(s, ctx)).join("");
  return (
    XML +
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld>${bg}<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(slide.transition)}</p:sld>`
  );
}

const rels = (items) =>
  XML +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith("http") ? type : `${REL}/${type}`}" Target="${target}"/>`).join("") +
  `</Relationships>`;

const THEME =
  XML +
  `<a:theme xmlns:a="${NS_A}" name="Orca PPT"><a:themeElements>` +
  `<a:clrScheme name="Orca PPT"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>` +
  ["4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"].map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join("") +
  `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>` +
  `<a:fontScheme name="Orca PPT"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  `<a:fmtScheme name="Orca PPT"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst>` +
  `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`).join("")}</a:lnStyleLst>` +
  `<a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst>` +
  `<a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>` +
  `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const EMPTY_TREE =
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`;

const MASTER =
  XML +
  `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT =
  XML +
  `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

/** 返回 zip 的 Buffer。meta: { title } */
export function buildPptx(model, meta = {}) {
  const n = model.slides.length;
  const files = [];
  const mediaTypes = new Set();
  const slideFiles = model.slides.map((slide, i) => {
    const slideRels = [["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]];
    const byMedia = new Map();
    const rel = (media) => {
      if (!byMedia.has(media)) {
        const id = `rId${slideRels.length + 1}`;
        byMedia.set(media, id);
        slideRels.push([id, "image", `../media/${media}`]);
        mediaTypes.add(media.split(".").pop());
      }
      return byMedia.get(media);
    };
    const xml = slideXml(slide, rel);
    return [
      { name: `ppt/slides/slide${i + 1}.xml`, data: xml },
      { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels(slideRels) },
    ];
  });

  const types = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg" };
  files.push({
    name: "[Content_Types].xml",
    data:
      XML +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      [...mediaTypes].map((ext) => `<Default Extension="${ext}" ContentType="${types[ext]}"/>`).join("") +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      `<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>` +
      `<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>` +
      `<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      model.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("") +
      `</Types>`,
  });
  files.push({
    name: "_rels/.rels",
    data: rels([
      ["rId1", "officeDocument", "ppt/presentation.xml"],
      ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
      ["rId3", "extended-properties", "docProps/app.xml"],
    ]),
  });
  files.push({
    name: "docProps/core.xml",
    data:
      XML +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<dc:title>${esc(meta.title || "")}</dc:title><dc:creator>Orca PPT</dc:creator></cp:coreProperties>`,
  });
  files.push({
    name: "docProps/app.xml",
    data:
      XML +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Orca PPT</Application><Slides>${n}</Slides></Properties>`,
  });
  files.push({
    name: "ppt/presentation.xml",
    data:
      XML +
      `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${model.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      `<p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
  });
  files.push({
    name: "ppt/_rels/presentation.xml.rels",
    data: rels([
      ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
      ...model.slides.map((_, i) => [`rId${i + 2}`, "slide", `slides/slide${i + 1}.xml`]),
      [`rId${n + 2}`, "theme", "theme/theme1.xml"],
      [`rId${n + 3}`, "presProps", "presProps.xml"],
      [`rId${n + 4}`, "viewProps", "viewProps.xml"],
      [`rId${n + 5}`, "tableStyles", "tableStyles.xml"],
    ]),
  });
  files.push({ name: "ppt/presProps.xml", data: XML + `<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>` });
  files.push({
    name: "ppt/viewProps.xml",
    data: XML + `<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
  });
  files.push({
    name: "ppt/tableStyles.xml",
    data: XML + `<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
  });
  files.push({ name: "ppt/slideMasters/slideMaster1.xml", data: MASTER });
  files.push({
    name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    data: rels([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
      ["rId2", "theme", "../theme/theme1.xml"],
    ]),
  });
  files.push({ name: "ppt/slideLayouts/slideLayout1.xml", data: LAYOUT });
  files.push({
    name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    data: rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
  });
  files.push({ name: "ppt/theme/theme1.xml", data: THEME });
  files.push(...slideFiles.flat());
  for (const [name, data] of model.media) files.push({ name: `ppt/media/${name}`, data });
  return writeZip(files);
}
