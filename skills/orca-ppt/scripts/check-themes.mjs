// 核主题文件有没有违反 references/themes.md「新建主题」那几条：
//
//   node scripts/check-themes.mjs
//
// - 字体只用本地的：不许 @import Google Fonts（断网阻塞渲染、录制拿不到最终字形）；
// - 不许改五个字号类的 font-size（文字宽度估算和页面坐标都建在固定字号上）；
// - 主题里不写颜色（颜色全在 runtime/palettes/，任意配色配任意主题）；
// - 新增类最多 4 个（tokens.css 里没有的类才算新增）。
//
// 静态读 CSS，不开浏览器，所以 `pnpm test` 每次都跑得起。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime");
// 案例专用主题：product-showcase.css 是四栏产品切换的局部配置，迁到标准主题之前不按通用规则核
const EXEMPT = new Set(["product-showcase.css"]);
const SIZE_CLASSES = ["t-display", "t-metric", "t-h1", "t-h2", "t-body"];

const classesIn = (css) => {
  const found = new Set();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
    if (m[1].trim().startsWith("@")) continue;
    for (const c of m[1].matchAll(/\.([a-z][a-z0-9-]*)/g)) found.add(c[1]);
  }
  return found;
};
const base = classesIn(readFileSync(join(RUNTIME, "tokens.css"), "utf8"));

let problems = 0;
for (const name of readdirSync(join(RUNTIME, "themes")).filter((f) => f.endsWith(".css")).sort()) {
  if (EXEMPT.has(name)) continue;
  const raw = readFileSync(join(RUNTIME, "themes", name), "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  if (/@import[^;]*fonts\.googleapis/.test(css)) out.push("@import 了 Google Fonts，字体只用本地的 ../fonts/fonts.css");
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1];
    const body = m[2];
    if (SIZE_CLASSES.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(selector)) && /(^|;)\s*font-size\s*:/.test(body)) {
      out.push(`${selector.trim()} 改了 font-size，字号类只许改字体、字重、行高、字距`);
    }
    const color = body.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    if (color) out.push(`${selector.trim()} 写了颜色「${color[0]}」，颜色放在配色文件里`);
  }
  const added = [...classesIn(css)].filter((c) => !base.has(c));
  if (added.length > 4) out.push(`新增了 ${added.length} 个类（${added.join("、")}），最多 4 个`);
  console.log(`${name.padEnd(28)} ${out.length ? `✗ ${out.length} 条` : "✓"}`);
  for (const o of out) console.log(`   ✗ ${o}`);
  problems += out.length;
}
process.exit(problems === 0 ? 0 : 1);
