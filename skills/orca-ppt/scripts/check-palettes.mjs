// 核每套配色的对比度。
//
//   node scripts/check-palettes.mjs
//   node scripts/check-palettes.mjs --debt     连已知欠账一起列出来
//
// 为什么要机器核:配色是「看着差不多就行」最容易骗过人的地方 —— 莫兰迪那种低饱和配色,
// 陶土强调色摆在豆沙面板上,单看每个颜色都好看,摞在一起数字就糊了。九套配色 × 十几对
// 组合,靠眼睛逐个比是不现实的,而且改一个色值就得全部重看。
//
// **这个脚本自己不知道任何配对,也不知道任何类绑了哪个变量**,两者都是读来的:
//
//   runtime/pairs.json   哪个类压在哪个类上、哪两个色块挨着(从 visual-spec.md 派生)
//   runtime/tokens.css   类 → 变量的映射(.t-accent 用 --accent-text,诸如此类)
//   runtime/palettes/    变量 → 色值
//
// 上一版把配对手抄成脚本里的一个数组,于是两种错都犯了:第一版多列了三对(把五个已发布
// 主题全判挂),改完又漏了柱状图和折线图那几对(九套配色全部违反而无人知晓)。
// 中间那道手抄就是漏洞的来源,所以现在没有手抄。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime");
const PALETTES = join(ROOT, "palettes");

const showDebt = process.argv.includes("--debt");

/**
 * 从 tokens.css 解析「类 → 它取哪个变量的颜色」。
 *
 * 只认 color / background / stroke 三个属性 —— 文字、色块、线条各一个。
 * 同一个类出现多次时后面的盖前面的(CSS 本来就是这个语义);
 * `.l-accent, .l-surface { fill: none; … }` 这种只写了非颜色属性的组会被跳过。
 */
function classToVar() {
  // 注释要先剥掉:它们就贴在选择器前面(`/* 文字 */\n.t-display { … }`),
  // 不剥的话选择器那一段会连着注释一起被切出来,一个类都认不出。
  const css = readFileSync(join(ROOT, "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const map = {};
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const paint = rule[2].match(/(?:^|[;\s])(?:color|background|stroke)\s*:\s*var\((--[\w-]+)\)/);
    if (!paint) continue;
    for (const sel of rule[1].split(",")) {
      const cls = sel.trim().match(/^\.([\w-]+)$/);
      if (cls) map["." + cls[1]] = paint[1];
    }
  }
  return map;
}

/** 配对里写的可能是类名(查 tokens.css)或直接是变量名(页面底那种没有类的)。 */
function resolve(token, map) {
  if (token.startsWith("--")) return token;
  const found = map[token];
  if (!found) throw new Error(`pairs.json 里的 ${token} 在 tokens.css 里找不到颜色定义`);
  return found;
}

function parsePalette(css) {
  const vars = {};
  for (const m of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

/** `#rgb` / `#rrggbb` / `rgba(r,g,b,a)` 都认。带透明度的按叠在 `over` 上算。 */
function rgb(value, over) {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const fn = value.match(/rgba?\(([^)]+)\)/);
  if (!fn) return null;
  const parts = fn[1].split(",").map((p) => parseFloat(p));
  const [r, g, b, a = 1] = parts;
  if (a === 1 || !over) return [r, g, b];
  return [r, g, b].map((c, i) => Math.round(c * a + over[i] * (1 - a)));
}

const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const map = classToVar();
const { pairs } = JSON.parse(readFileSync(join(ROOT, "pairs.json"), "utf8"));

// 不同配对可能落到同一组变量上(比如 .t-accent 和 .t-metric 都是 --accent-text),
// 算出来是同一个数。按变量对去重,只保留第一条 —— 否则报告里同一个问题会说两遍。
const seen = new Set();
const checks = [];
for (const pair of pairs) {
  const fg = resolve(pair.fg, map);
  const bg = resolve(pair.bg, map);
  const key = `${fg}|${bg}`;
  if (seen.has(key)) continue;
  seen.add(key);
  checks.push({ ...pair, fgVar: fg, bgVar: bg });
}

let bad = 0;
let debts = 0;
for (const file of readdirSync(PALETTES).filter((n) => n.endsWith(".css")).sort()) {
  const vars = parsePalette(readFileSync(join(PALETTES, file), "utf8"));
  const name = file.replace(/\.css$/, "");
  const fails = [];
  const notes = [];
  for (const check of checks) {
    const bgColor = rgb(vars[check.bgVar]);
    const fgColor = rgb(vars[check.fgVar], bgColor);
    if (!bgColor || !fgColor) continue;
    const ratio = contrast(fgColor, bgColor);
    if (ratio >= check.need) continue;
    const line = `${check.what} ${ratio.toFixed(2)}:1（要 ${check.need}:1）`;
    if (check.level === "hard") fails.push(line);
    else if (check.debt) notes.push({ line, debt: true });
    else notes.push({ line, debt: false });
  }
  bad += fails.length;
  debts += notes.filter((n) => n.debt).length;

  const shown = notes.filter((n) => showDebt || !n.debt);
  console.log(`${name.padEnd(14)} ${fails.length === 0 ? "✓" : "✗"}`);
  for (const fail of fails) console.log(`   ✗ ${fail}`);
  for (const note of shown) {
    console.log(`   · ${note.line}${note.debt ? "（已知欠账）" : "（偏淡，看一眼）"}`);
  }
}

console.log(`\n${checks.length} 对组合 × ${readdirSync(PALETTES).filter((n) => n.endsWith(".css")).length} 套配色`);
if (debts > 0 && !showDebt) {
  console.log(`已知欠账 ${debts} 条没显示，原委写在 runtime/pairs.json 的 debt 字段里，`);
  console.log(`要看跑 node scripts/check-palettes.mjs --debt`);
}
process.exit(bad === 0 ? 0 : 1);
