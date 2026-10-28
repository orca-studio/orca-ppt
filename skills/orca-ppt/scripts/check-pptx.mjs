// 核对 export-pptx.mjs 导出的包：结构对不对、降级是不是按表来的。
//
//   node scripts/check-pptx.mjs <deck.pptx> <report.json>
//
// report.json 是 export-pptx.mjs --json 写的那份。有错误退出码 1；警告只打印。
//
// 结构：
//   - zip 完整，每个部件在 [Content_Types].xml 里有类型，每条关系指向的部件都在
//   - 每页的文字和浏览器里量的一致：一段是作者写的一段，<br> 另起一段，排版折出来的行并在段里
//   - 文本框不缩字（noAutofit）：折行交给 PowerPoint，字号不许它改
//   - 图片只有报告里写了原因的那些，没有意外转成图片的元素
//   - 形状 id 不重复，动画和图片引用的东西都在
//   - 共享元素在前后两页里都有：一块的叫 `!!键`，几块的每块叫 `!!键~标签`（不收成组，组里的形状平滑不按名字配），
//     名字不重复；前后两页至少有一块名字相同
//   - 绕圆心转的元素每页都写了旋转（0° 也写）
// 降级（references/transitions.md「导出 PPTX」）：
//   - 每次翻页的转场按表来：保真档是平滑，降级档是淡入淡出……
//   - 平滑都带旧版 PowerPoint 的回退
//   - 报告的降级清单没漏
// 警告：
//   - 平滑翻页的前后两页里有同类、同色、没起名字的形状，换了位置或大小 ——
//     PowerPoint 会自动把它们配成一对，网页里没有这个运动
import { readFileSync } from "node:fs";
import path from "node:path";
import { readZip } from "./lib/zip.mjs";
import { parseXml, findAll, find, child } from "./lib/xml.mjs";
import { pageTransition } from "./lib/pptx-fallback.mjs";

const [pptxPath, reportPath] = process.argv.slice(2);
if (!pptxPath || !reportPath) {
  console.error("用法：node scripts/check-pptx.mjs <deck.pptx> <report.json>");
  process.exit(1);
}

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}：${msg}`);
const warn = (where, msg) => warnings.push(`${where}：${msg}`);

const report = JSON.parse(readFileSync(reportPath, "utf8"));
let files;
try {
  files = readZip(readFileSync(pptxPath));
} catch (e) {
  console.error(`✗ ${pptxPath}：${e.message}`);
  process.exit(1);
}
const xml = (name) => parseXml(files.get(name).toString("utf8"));

// ── 包：类型和关系
const types = xml("[Content_Types].xml");
const defaults = new Set(findAll(types, "Default").map((d) => d.attrs.Extension.toLowerCase()));
const overrides = new Set(findAll(types, "Override").map((o) => o.attrs.PartName.slice(1)));
for (const name of files.keys()) {
  if (name.endsWith("/")) continue;
  const ext = name.split(".").pop().toLowerCase();
  if (!overrides.has(name) && !defaults.has(ext)) err("包", `${name} 没有内容类型`);
}
for (const name of overrides) if (!files.has(name)) err("包", `[Content_Types].xml 列了 ${name}，包里没有`);

/** 读一个部件的关系：Map<rId, 目标部件的完整路径> */
function relsOf(part) {
  const dir = path.posix.dirname(part);
  const relsName = `${dir === "." ? "" : dir + "/"}_rels/${path.posix.basename(part)}.rels`;
  const map = new Map();
  if (!files.has(relsName)) return map;
  for (const r of findAll(xml(relsName), "Relationship")) {
    if (r.attrs.TargetMode === "External") continue;
    const target = path.posix.normalize(path.posix.join(dir, r.attrs.Target));
    map.set(r.attrs.Id, target);
    if (!files.has(target)) err("包", `${relsName} 的 ${r.attrs.Id} 指向 ${target}，包里没有`);
  }
  return map;
}
relsOf("");
const presRels = relsOf("ppt/presentation.xml");
const presentation = xml("ppt/presentation.xml");
const slideParts = findAll(presentation, "p:sldId").map((s) => presRels.get(s.attrs["r:id"]));
for (const part of new Set([...presRels.values()].filter((p) => p.endsWith(".xml")))) relsOf(part);

if (slideParts.length !== report.slides.length) {
  err("包", `${slideParts.length} 页，报告里是 ${report.slides.length} 页`);
}

// ── 每页
const nameOf = (el) => find(el, "p:cNvPr")?.attrs.name ?? "";
/** spTree 的直接孩子（形状、图片、组） */
const topShapes = (tree) => tree.children.filter((c) => ["p:sp", "p:pic", "p:grpSp", "p:cxnSp", "p:graphicFrame"].includes(c.name));
const xfrmOf = (shape) => {
  const pr = child(shape, "p:spPr") ?? child(shape, "p:grpSpPr");
  return pr && child(pr, "a:xfrm");
};
/** 一页的转场：{ kind, fallback, dir } */
function transitionOf(slide) {
  const alt = slide.children.find((c) => c.name === "mc:AlternateContent");
  const direct = child(slide, "p:transition");
  const t = alt ? find(child(alt, "mc:Choice"), "p:transition") : direct;
  if (!t) return { kind: "none", fallback: true };
  const effect = t.children[0]?.name ?? "";
  const kind = { "p159:morph": "morph", "p:fade": "fade", "p:wipe": "wipe" }[effect] ?? (effect || "none");
  return { kind, dir: t.children[0]?.attrs.dir, fallback: !alt || !!find(alt, "mc:Fallback") };
}

const pages = [];
slideParts.forEach((part, i) => {
  const where = `第 ${i + 1} 页`;
  const expected = report.slides[i];
  if (!part || !files.has(part)) return err(where, "部件不在包里");
  const slide = xml(part);
  const rels = relsOf(part);
  const tree = find(slide, "p:spTree");

  // 文字：逐段和浏览器量的一致
  const paras = findAll(tree, "a:p")
    .map((p) => findAll(p, "a:t").map((t) => t.text).join(""))
    .filter((t) => t);
  if (expected) {
    const want = expected.texts;
    if (paras.length !== want.length || paras.some((t, k) => t !== want[k])) {
      const k = paras.findIndex((t, j) => t !== want[j]);
      err(where, `文字或分段变了：第 ${k + 1} 段是「${paras[k] ?? "（没有）"}」，应该是「${want[k] ?? "（没有）"}」`);
    }
  }
  for (const body of findAll(tree, "a:bodyPr")) {
    if (!find(body, "a:noAutofit")) err(where, "有文本框会让 PowerPoint 缩字（不是 noAutofit）");
  }

  // 图片：数量和报告一致，每张都有原因
  const pics = findAll(tree, "p:pic");
  if (expected && pics.length !== expected.rasters.length) {
    err(where, `${pics.length} 张图片，报告里转成图片的元素是 ${expected.rasters.length} 个`);
  }
  for (const r of expected?.rasters ?? []) if (!r.reason) err(where, `${r.name} 转成了图片，没写原因`);
  for (const blip of findAll(slide, "a:blip")) {
    if (!rels.has(blip.attrs["r:embed"])) err(where, `图片引用 ${blip.attrs["r:embed"]} 没有对应的关系`);
  }

  // id 不重复，动画目标都在
  const ids = findAll(tree, "p:cNvPr").map((c) => c.attrs.id);
  const dup = ids.filter((id, k) => ids.indexOf(id) !== k);
  if (dup.length) err(where, `形状 id 重复：${[...new Set(dup)].join(", ")}`);
  for (const t of findAll(slide, "p:spTgt")) {
    if (!ids.includes(t.attrs.spid)) err(where, `动画指向不存在的形状 ${t.attrs.spid}`);
  }

  // 共享元素：键 → 它的几块形状（`!!键` 或 `!!键~标签`）
  const named = new Map();
  const names = new Map();
  for (const shape of findAll(tree, "p:sp").concat(findAll(tree, "p:pic"), findAll(tree, "p:grpSp"))) {
    const n = nameOf(shape);
    if (!n.startsWith("!!")) continue;
    names.set(n, (names.get(n) ?? 0) + 1);
    const key = `!!${n.slice(2).split("~")[0]}`;
    if (!named.has(key)) named.set(key, []);
    named.get(key).push(shape);
  }
  for (const [n, count] of names) if (count > 1) err(where, `${n} 有 ${count} 个，平滑不知道配哪个`);
  for (const key of expected?.identities ?? []) {
    const list = named.get(`!!${key}`) ?? [];
    if (!list.length) err(where, `共享元素 ${key} 没有 !!${key} 开头的形状`);
    else if (list.length > 1 && list.some((s) => nameOf(s) === `!!${key}`)) {
      err(where, `共享元素 ${key} 有几块，每块要叫 !!${key}~标签，不能有一块叫 !!${key}`);
    }
    if (list.some((s) => s.name === "p:grpSp")) err(where, `共享元素 ${key} 收成了组，组里的形状平滑不按名字配`);
  }
  // 绕圆心转：每页都写 rot
  for (const key of expected?.turn ?? []) {
    const leaves = named.get(`!!${key}`) ?? [];
    if (leaves.some((s) => xfrmOf(s)?.attrs.rot === undefined)) {
      err(where, `绕圆心转的 ${key} 没写旋转（0° 也要写，否则 PowerPoint 那一页会放大加虚化）`);
    }
  }

  const transition = transitionOf(slide);
  pages.push({ named, transition, tree });

  // ── 降级：独立按表再判一遍
  if (!expected) return;
  const want = i === 0 ? { kind: "none", tier: "保真" } : pageTransition(expected.facts);
  if (transition.kind !== want.kind) {
    err(where, `转场是 ${transition.kind}，按「导出 PPTX」表应该是 ${want.kind}（${want.technique ?? "无手法"}，${want.tier}）`);
  }
  if (want.dir && transition.dir !== want.dir) err(where, `擦除方向是 ${transition.dir}，应该是 ${want.dir}`);
  if (expected.transition.tier !== want.tier) err(where, `报告写的档位是 ${expected.transition.tier}，按表应该是 ${want.tier}`);
  if (transition.kind === "morph" && !transition.fallback) err(where, "平滑没有给旧版 PowerPoint 的回退");
  if (want.tier !== "保真" && !report.degraded.some((d) => d.to === i + 1)) {
    err(where, `降级（${want.tier}）没写进报告的降级清单`);
  }
  if (transition.kind === "morph") {
    const prev = pages[i - 1];
    for (const key of expected.facts.shared) {
      if (!prev?.named.has(`!!${key}`) || !pages[i].named.has(`!!${key}`)) {
        err(where, `共享元素 ${key} 在前后两页里没有都叫 !!${key}，平滑配不上`);
        continue;
      }
      // 一页叫 `!!键`、一页叫 `!!键~标签`，或者两页的标签没有一个相同：一块也配不上
      const before = new Set(prev.named.get(`!!${key}`).map(nameOf));
      if (!pages[i].named.get(`!!${key}`).some((s) => before.has(nameOf(s)))) {
        err(where, `共享元素 ${key} 前后两页的形状名字没有一个相同，平滑配不上`);
      }
    }
  }
});

// ── 警告：PowerPoint 自动配对同类形状
const looks = (shape) => {
  const geom = find(shape, "a:prstGeom")?.attrs.prst;
  const fill = find(child(shape, "p:spPr") ?? shape, "a:srgbClr")?.attrs.val;
  const x = xfrmOf(shape);
  const off = x && child(x, "a:off");
  const ext = x && child(x, "a:ext");
  return { key: `${geom}|${fill}`, box: off && ext ? `${off.attrs.x},${off.attrs.y},${ext.attrs.cx},${ext.attrs.cy}` : "" };
};
pages.forEach((page, i) => {
  if (i === 0 || page.transition.kind !== "morph") return;
  const unnamed = (tree) =>
    topShapes(tree)
      .filter((s) => s.name === "p:sp" && !nameOf(s).startsWith("!!") && !find(s, "a:t"))
      .map(looks);
  const before = unnamed(pages[i - 1].tree);
  const after = unnamed(page.tree);
  const risky = after.filter((a) => {
    const same = before.filter((b) => b.key === a.key);
    return same.length && !same.some((b) => b.box === a.box);
  });
  if (risky.length) {
    warn(`第 ${i}→${i + 1} 页`, `${risky.length} 个没起名字的形状和上一页的同类同色形状位置不同，PowerPoint 可能自动配对、做出网页里没有的运动`);
  }
});

const label = path.basename(pptxPath);
for (const w of warnings) console.log(`  ⚠ ${w}`);
if (errors.length) {
  console.log(`✗ ${label}：${errors.length} 个错误`);
  for (const e of errors) console.log(`  ${e}`);
  process.exit(1);
}
console.log(`✓ ${label}：${slideParts.length} 页，结构和降级都对${warnings.length ? `（${warnings.length} 条警告）` : ""}`);
