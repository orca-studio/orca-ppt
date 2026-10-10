// 扫 examples/ 生成一个本地 gallery 页面。
// 数据全部从稿子本身读出来，不另建元数据文件：
//   主题   ← HTML 里引的 runtime/themes/*.css
//   版式   ← 转场计划注释里的「版式 xxx」
//   手法   ← 转场计划注释里每行的「手法：…」
//   页数   ← <section> 的个数
//   时长   ← ffprobe 读 index.mp4
//   缩略图 ← ffmpeg 从 index.mp4 抽一帧
// 用法：node scripts/gallery.mjs   （或 npm run dev）
// 环境变量 GA_ID 有值时，生成的页面会带上 Google Analytics 代码（本地预览不设就没有）。
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(ROOT, "examples");
// 页面生成在仓库根目录，这样 npx serve . 之后 localhost:3000 直接就是它。
// 缩略图放进各自的示例目录（examples/<name>/thumb.jpg）—— 它本来就属于那份示例，
// 不为它单开一个顶层目录。两者都是生成物，不进版本库。
const PAGE = join(ROOT, "index.html");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const hasFfmpeg = run("ffmpeg", ["-version"]) !== null;
const hasFfprobe = run("ffprobe", ["-version"]) !== null;

// 色板：挑三个能代表这套主题、而且在深色卡片上看得见的颜色。
// 直接取 bg/surface/accent 的话，暗色主题的前两个会和卡片同色，只剩一圈描边。
const CARD_BG = "#16161c";
const MIN_FROM_CARD = 45;   // 和卡片底色的最小距离，低于这个就看不见
const MIN_BETWEEN = 30;     // 两个色板之间的最小距离，太近就是重复

const rgb = (hex) => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const dist = (a, b) => {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
};

// 版式族：身份写在起始文件里（templates/starter.html、story-starter.html、layouts/bento.html），
// 稿子从哪个文件复制出来就带哪个标记，不靠写稿的人记得填。
//
// 名字沿用 SKILL.md 的「两种模式」，不另造词。注意 standard / story 是模式，
// 而 bento 在 visual-spec.md 里其实是「汇报稿」内部的一种页面类型，不是和它并列的模式。
// 这里仍然把它摆成并列的一项 —— 浏览时想问的是「哪几份能看到 bento」，
// 不是「它在规范里挂在第几级」。
// 只有两种**模式**（SKILL.md 的「两种模式」，对应两个起始文件）。
// Bento、时间线这些是**页型**，走 data-tags —— 它们是叠加的，一份稿子可以有好几种，
// 不该和模式挤在一个互斥的枚举里。
const LAYOUT_NAMES = { standard: "汇报稿", story: "故事稿" };
const layoutName = (k) => (k ? LAYOUT_NAMES[k] || k : "未标注");

function parseDeck(name) {
  const dir = join(EXAMPLES, name);
  const htmlPath = join(dir, "index.html");
  if (!existsSync(htmlPath)) return null;
  const html = readFileSync(htmlPath, "utf8");

  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, name])[1].trim();
  const pages = (html.match(/<section[\s>]/g) || []).length;

  const planBlock = (html.match(/<!--[^]*?转场计划[^]*?-->/) || [""])[0];
  // 版式标记读 <html data-layout>。以前从「转场计划」注释里读「版式 xxx」——
  // 那个注释多数稿子根本没有，结果每一份都显示「未标注」，这段等于没在跑。
  const layout = (html.match(/<html[^>]*\bdata-layout="([a-z0-9-]+)"/) || [])[1] || null;
  // 页型标签：空格分隔，一份稿子可以有好几个。
  const pageTags = ((html.match(/<html[^>]*\bdata-tags="([^"]*)"/) || [])[1] || "")
    .split(/\s+/)
    .filter(Boolean);
  const moves = [];
  for (const m of planBlock.matchAll(/手法：([^\n]+)/g)) {
    // 「整页推近            from：…」→ 取到两个以上空格之前
    const move = m[1].split(/\s{2,}/)[0].trim().replace(/（.*$/, "");
    for (const part of move.split(/\s*\+\s*/)) {
      const v = part.trim();
      if (v && !moves.includes(v)) moves.push(v);
    }
  }

  const mp4 = join(dir, "index.mp4");
  // seconds 只用来给缩略图定位（跳到 35% 处），不显示在卡片上
  let seconds = null, thumb = null;
  if (existsSync(mp4)) {
    if (hasFfprobe) {
      const d = run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", mp4]);
      if (d) seconds = Math.round(parseFloat(d) * 10) / 10;
    }
    if (hasFfmpeg) {
      // 不取封面：同一套主题的几份稿子封面往往同源（页眉 + 大标题 + 装饰），
      // 取第一帧会让它们在首页上撞脸。跳到 35% 处，用 ffmpeg 的 thumbnail 滤镜
      // 从两秒里挑一帧最有代表性的 —— 它会避开转场中途那些糊帧。
      const out = join(dir, "thumb.jpg");
      const from = seconds ? Math.max(1, seconds * 0.35).toFixed(2) : "1";
      const ok = run("ffmpeg", ["-v", "error", "-ss", from, "-i", mp4,
        "-frames:v", "1", "-vf", "thumbnail=60,scale=848:-1", "-q:v", "4", "-y", out]);
      if (ok !== null && existsSync(out)) thumb = `examples/${name}/thumb.jpg`;
    }
  }

  return {
    name, title, layout, pages, moves, seconds, thumb,
    mtime: statSync(htmlPath).mtimeMs,
    hasVideo: existsSync(mp4),
    hasTutorial: existsSync(join(dir, "tutorial.html")),
  };
}

// 留在磁盘上但不给入口的示例
const SKIP = new Set(["q3-report", "q3-report-v2"]);

const decks = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".") && !SKIP.has(d.name))
  .map((d) => parseDeck(d.name))
  .filter(Boolean)
  .sort((a, b) => b.mtime - a.mtime);

function group(keyOf, labelOf) {
  const m = new Map();
  for (const d of decks) {
    const k = keyOf(d);
    if (!m.has(k)) m.set(k, { key: k, label: labelOf(d), count: 0 });
    m.get(k).count += 1;
  }
  return [{ key: "all", label: "全部", count: decks.length },
    ...[...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))];
}
const layoutTabs = group((d) => d.layout || "unknown", (d) => layoutName(d.layout));

function card(d) {
  const meta = `${d.pages} 页`;
  const chips = d.moves.slice(0, 5).map((m) => `<span class="chip">${esc(m)}</span>`).join("");
  const thumb = d.thumb
    ? `<img class="shot" src="${esc(d.thumb)}" alt="${esc(d.name)} 首帧" loading="lazy">`
    : `<div class="shot empty"><span>没有 index.mp4</span></div>`;
  return `<article class="card" data-layout="${esc(d.layout || "unknown")}">
  <a class="thumb play" data-name="${esc(d.name)}" href="examples/${esc(d.name)}/">${thumb}
    <span class="hover"><span class="btn solid">放映</span></span>
  </a>
  <div class="body">
    ${chips ? `<div class="chips">${chips}</div>` : `<p class="nochip">没写转场计划</p>`}
    <div class="row">
      <a class="name play" data-name="${esc(d.name)}" href="examples/${esc(d.name)}/">${esc(d.name)}</a>
      <span class="meta">${esc(meta)}</span>
    </div>
    ${d.hasTutorial ? `<p><a href="examples/${esc(d.name)}/tutorial.html">动画拆解与提示词 →</a></p>` : ""}
  </div>
</article>`;
}

const page = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PPT 转场动画 · orca-transition-skill</title>
${process.env.GA_ID ? `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(process.env.GA_ID)}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${esc(process.env.GA_ID)}');
</script>` : ""}
<!-- 本地字体：这个页面和 site/ 都不该依赖公网，见 scripts/fetch-fonts.mjs -->
<link rel="stylesheet" href="runtime/fonts/fonts.css">
<style>
:root{--bg:#0b0b0f;--card:#16161c;--line:#23232c;--text:#f5f5f7;--dim:#8e8e98;--faint:#6e6e78;--accent:#ff7a1a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:"Work Sans","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1440px;margin:0 auto;padding:60px}
header{display:block}
.eyebrow{margin:0;font-family:"JetBrains Mono",monospace;font-size:12px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h1{margin:12px 0 0;font-family:"Bricolage Grotesque","PingFang SC",sans-serif;font-size:48px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
hr{border:0;height:1px;background:#1f1f27;margin:28px 0}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 28px}
.tab{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:11px 16px;background:var(--card);color:var(--dim);border:1px solid var(--line);border-radius:999px;font-family:"Work Sans","PingFang SC",sans-serif;font-size:13.5px;font-weight:500;cursor:pointer}
.tab:hover{color:var(--text);border-color:#33333f}
.tab .n{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--faint)}
.tab[aria-selected="true"]{background:var(--accent);color:#0b0b0f;border-color:var(--accent);font-weight:600}
.tab[aria-selected="true"] .n{color:rgba(11,11,15,.6)}
.warn{margin:0 0 28px;font-family:"JetBrains Mono",monospace;font-size:11.5px;color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:24px}
.card{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
/* .card 上的 display:flex 会盖掉 hidden 属性自带的 display:none（作者样式优先于浏览器默认样式） */
.card[hidden]{display:none!important}
.card:hover{border-color:var(--accent)}
.thumb{position:relative;display:block;aspect-ratio:16/9;background:#141419;text-decoration:none}
.shot{display:block;width:100%;height:100%;object-fit:cover}
.shot.empty{display:flex;align-items:center;justify-content:center;font-family:"JetBrains Mono",monospace;font-size:11px;color:#5e5e68;border-bottom:1px solid var(--line)}
.hover{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:rgba(11,11,15,.55);opacity:0;transition:opacity .15s}
.card:hover .hover,.thumb:focus-visible .hover{opacity:1}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:11px 18px;font-size:13.5px;font-weight:600;border-radius:7px}
.btn.solid{background:var(--accent);color:#0b0b0f}
.body{padding:18px 20px 18px;display:flex;flex-direction:column;gap:14px}
.row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.name{font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:.02em;color:var(--dim);text-decoration:none}
.name:hover{color:var(--accent)}
.nochip{margin:0;font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--faint)}
.meta{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--faint);white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:8px}
/* 转场手法是这个首页真正要展示的东西，给它最高的视觉权重 */
.chip{font-size:14.5px;font-weight:500;color:var(--text);background:#21212b;border:1px solid #30303c;border-radius:8px;padding:7px 12px;line-height:1.2}
#viewer{padding:0;border:0;background:transparent;max-width:100vw;max-height:100vh}
#viewer::backdrop{background:rgba(6,6,9,.97);backdrop-filter:blur(6px)}
.vbox{display:flex;flex-direction:column;gap:10px;width:min(92vw,150vh)}
.vbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.vtitle{font-size:16px;font-weight:600;color:var(--text)}
.vnav{display:flex;align-items:center;gap:8px}
.vbtn{min-width:44px;min-height:36px;padding:8px 12px;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:7px;font-family:inherit;font-size:14px;line-height:1;cursor:pointer}
.vbtn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.vbtn:disabled{opacity:.35;cursor:default}
.vpage{min-width:56px;text-align:center;font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--dim)}
.vhint{flex-grow:1;font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--faint)}
.vopen{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--accent);text-decoration:none}
.vopen:hover{text-decoration:underline}
.vclose{min-height:36px;padding:8px 16px;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:7px;font-family:inherit;font-size:13px;cursor:pointer}
.vclose:hover{border-color:var(--accent);color:var(--accent)}
.vframe{width:100%;aspect-ratio:16/9;border:0;border-radius:10px;background:#000;display:block}
@media (max-width:640px){.wrap{padding:28px 20px}h1{font-size:34px}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <p class="eyebrow">orca-transition-skill</p>
    <h1>PPT 转场动画</h1>
  </div>
</header>
<hr>
<div class="tabs" role="tablist">
${layoutTabs.map((t, i) => `  <button class="tab" role="tab" data-filter="${esc(t.key)}" aria-selected="${i === 0}">${esc(t.label)}<span class="n">${t.count}</span></button>`).join("\n")}
</div>
${hasFfmpeg ? "" : '<p class="warn">未装 ffmpeg，缩略图和时长缺失</p>'}
<div class="grid">
${decks.map(card).join("\n")}
</div>
</div>

<dialog id="viewer">
  <div class="vbox">
    <div class="vbar">
      <span class="vtitle"></span>
      <span class="vnav">
        <button class="vbtn vprev" type="button" aria-label="上一页">←</button>
        <span class="vpage" aria-live="polite">— / —</span>
        <button class="vbtn vnext" type="button" aria-label="下一页">→</button>
      </span>
      <span class="vhint">← → 翻页 · 只有往后翻会播转场 · Esc 关闭</span>
      <a class="vopen" href="#" target="_blank" rel="noopener">新标签页打开</a>
      <button class="vclose" type="button" aria-label="关闭">关闭</button>
    </div>
    <iframe class="vframe" title="放映" allow="fullscreen"></iframe>
  </div>
</dialog>

<script>
(() => {
  // 放映用弹窗，不跳走。原来的 href 保留：中键 / cmd 点击还是新标签页打开，
  // 没有 JS 时也能点开。
  const dlg = document.getElementById("viewer");
  const frame = dlg.querySelector(".vframe");
  dlg.querySelector(".vclose").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => { frame.src = "about:blank"; });
  const prevBtn = dlg.querySelector(".vprev");
  const nextBtn = dlg.querySelector(".vnext");
  const pageLbl = dlg.querySelector(".vpage");
  let deck = null;   // iframe 里的 Reveal 实例，同源才拿得到

  const sync = () => {
    if (!deck) return;
    const i = deck.getIndices().h, n = deck.getTotalSlides();
    pageLbl.textContent = (i + 1) + " / " + n;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i >= n - 1;
  };
  const go = (fn) => () => { if (deck) { deck[fn](); sync(); try { frame.contentWindow.focus(); } catch (e) {} } };
  prevBtn.addEventListener("click", go("prev"));
  nextBtn.addEventListener("click", go("next"));

  frame.addEventListener("load", () => {
    deck = null;
    prevBtn.disabled = nextBtn.disabled = true;
    pageLbl.textContent = "— / —";
    try {
      // 同源时把 Esc 接过来：焦点在 iframe 里的时候，父页面收不到按键，
      // 而 reveal 自己把 Esc 用在总览模式上，不接管就关不掉弹窗。
      frame.contentDocument.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); dlg.close(); }
      }, true);
      frame.contentWindow.focus();
      // Reveal 是异步初始化的，等它出现（最多两秒）再接上翻页按钮
      let tries = 0;
      const wait = setInterval(() => {
        const R = frame.contentWindow.Reveal;
        if (R && R.isReady && R.isReady()) {
          clearInterval(wait);
          deck = R;
          R.on("slidechanged", sync);
          sync();
        } else if (++tries > 40) {
          clearInterval(wait);   // 拿不到就只留键盘翻页，按钮保持禁用
        }
      }, 50);
    } catch (err) { /* 跨源（file:// 下可能发生）：按钮用不了，键盘和关闭按钮仍然有效 */ }
  });
  document.querySelectorAll("a.play").forEach((a) => a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    dlg.querySelector(".vtitle").textContent = a.dataset.name;
    dlg.querySelector(".vopen").href = href;
    frame.src = href;
    dlg.showModal();
  }));

  const tabs = [...document.querySelectorAll(".tab")];
  const cards = [...document.querySelectorAll(".card")];
  tabs.forEach((t) => t.addEventListener("click", () => {
    const k = t.dataset.filter;
    tabs.forEach((o) => o.setAttribute("aria-selected", String(o === t)));
    cards.forEach((c) => { c.hidden = k !== "all" && c.dataset.layout !== k; });
  }));
})();
</script>
</body>
</html>
`;

writeFileSync(PAGE, page);
console.log(`index.html  ${decks.length} 份示例，${decks.filter((d) => d.thumb).length} 张缩略图`);
if (!hasFfmpeg) console.log("没找到 ffmpeg：缩略图跳过");
if (!hasFfprobe) console.log("没找到 ffprobe：页数照常，时长跳过");
