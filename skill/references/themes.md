# 主题规范

主题只换「长什么样」：颜色、圆角、字体。网格、字号档位、页面类型、转场手法全部不变，
所以换了主题的稿子，转场照样对得上。

默认主题就是 `runtime/tokens.css` 本身（暗底橙色）。其他主题放在 `runtime/themes/`：

| 主题 | 样子 | 来源 |
| --- | --- | --- |
| `editorial-forest.css` | 燕麦米色纸面，森林绿大面板，灰粉强调；Source Serif 4 + JetBrains Mono | frontend-slides bold-template-pack |
| `clearing.css` | 群青底，白色半透明图形，黄色主角；Inter + JetBrains Mono | 一段 Remotion 日历产品动效（orca-motion-skill 示例） |
| `soft-editorial.css` | 奶油纸面，粉 / 黄绿 / 桃三色大圆角卡片；Cormorant Garamond + Work Sans | frontend-slides bold-template-pack |
| `emerald-editorial.css` | 饱和翡翠绿画布，深海军蓝反转面板，燕麦米交替面；圆角全零，4px 结构线；Bodoni Moda 900 + Manrope | beautiful-html-templates/emerald-editorial |
| `editorial-tri-tone.css` | 腮红粉画布，酒红深面板，奶油黄卡片；胶囊标签 + 大圆角卡片；Bricolage Grotesque + Instrument Serif + JetBrains Mono | beautiful-html-templates/editorial-tri-tone |

## 使用主题

在 `tokens.css` **之后**加一行：

```html
<link rel="stylesheet" href="{{ROOT}}/runtime/tokens.css">
<link rel="stylesheet" href="{{ROOT}}/runtime/themes/editorial-forest.css">
```

写页面前**先读主题文件开头的注释**，里面写着三件事：
1. 每个颜色变量在这个主题里是什么颜色；
2. 哪些颜色可以互变（形态变换、一变多只能在这些颜色之间变）；
3. 这个主题新增了哪些类。

用了主题新增的类，这份稿子就只能配这个主题。

## 新建主题

用户要一种现有主题里没有的风格时，在 `runtime/themes/` 下新建一个文件。只许做下面这些事。

### 1. 覆盖颜色变量（必须全部覆盖）

| 变量 | 用途 | 要求 |
| --- | --- | --- |
| `--bg` | 页面底色 | |
| `--surface` | 大面板、整页形状 | 和 `--bg` 明显区分 |
| `--surface-2` | 小卡片、普通柱 | 和 `--surface`、`--bg` 都能区分 |
| `--text` | `--bg` 上的文字 | 在 `--bg` 上清楚可读 |
| `--text-dim` | 说明文字 | 在 `--bg` 上仍可读 |
| `--text-on-surface` | `.s-surface` 上的文字 | 在 `--surface` 上清楚可读 |
| `--accent` | 强调**色块**的底色（`.s-accent` `.s-dot` 强调条、重点柱） | 在 `--bg` 和 `--surface` 上都显眼 |
| `--accent-soft` | 强调色的弱化版 | 和 `--accent` 同色系 |
| `--text-on-accent` | `.s-accent` / `.s-accent-soft` 上的文字 | 在这两个色块上清楚可读 |
| `--accent-text` | 强调色的**文字档**（`.t-accent` `.t-metric`） | 在 `--bg` 上清楚可读（≥4.5:1） |

**`--accent` 和 `--accent-soft` 必须同色系**，因为规范默认它们可以互变。

**`--accent` 和 `--accent-text` 是同一个强调色的两档，不能合并成一个值。**
色块底色要浅，好让 `--text-on-accent` 的深字压上去；落在浅色 `--bg` 上的强调文字要深。
同一个色值满足不了这两个要求 —— blush 的奶油黄压在腮红粉上量出来 1.02:1，两个颜色
**亮度几乎完全相同**，只剩色相差，缩略图和投影里那行字是消失的。`--accent-text` 取
`--accent` 的同色相深档即可；深底配色（`--bg` 本来就暗）两者常常可以是同一个值。
`--surface` 和 `--surface-2` 不要求同色系，但不是同色系时要在文件注释里写明「不能互变」。
**所有颜色都是高明度浅色（马卡龙色、粉彩）时**，任意两个之间变色都不会发灰发棕，
可以在注释里写「任意两个之间都可以互变」，形态变换、一变多、多合一就不受同色系限制。
有一个是深色或高饱和的颜色，就不能这么写。

### 主题和配色是两层

**主题**给字体、字重字距、圆角、新增类；**配色**给那 10 个颜色变量。稿子按这个顺序引：

```
tokens.css → runtime/themes/<主题>.css → runtime/palettes/<配色>.css
```

配色在主题之后，盖掉同名值。**配色通用**：任何配色都能配任何主题 —— 10 个变量和字体
之间没有结构依赖，技术上本来就能任意搭。搭得难看是人的责任，不是系统拦。

主题头里写 `默认配色：<id>`，选择器用它渲样张。

**为什么不做成「变体就是另一个主题文件」**（这里原来是这么写的，错了）：量下来每个主题的
颜色**就是那十来个变量**，`:root` 之外一个写死的颜色都没有；而字体、字阶、`.t-label`
`.s-ring` 这些是 8–24 行。复制一份主题文件去改颜色，等于把那 8–24 行复制 N 份，然后漂。

**配一套新配色时，不要找「四个好看的颜色」，按角色找**：

```
一个底色 + 一对文字色 + 两档强调色（色块档 + 文字档）+ 两级面板 + 面板和强调块上的文字
```

底色和文字色决定整体气质，强调色只负责点睛 —— 规范里「一页最多一个 highlight 格
用 `.s-accent` 铺底，其余格只用 `.s-surface` / `.s-surface-2`」就是这个逻辑。
四块全填实色会变成色块拼盘，重点反而没了。

**加一套配色必须跑 `npm run palettes`。** 低饱和配色最容易骗过眼睛：莫兰迪的豆沙面板
配白字单看没问题，量出来只有 2.76:1，离屏幕两米就读不动。这个 bug 就是它抓到的。

**核哪些组合写在 `runtime/pairs.json`**，不在校验器里，也不在这份文档里 —— 这份表是
`visual-spec.md` 的派生物（每条都带 `where` 指回规范出处），校验器读它，再从
`tokens.css` 解析「类 → 变量」。三者各自只有一个来源，改一处不用同步另外两处。

为什么要单独一份文件：上一版的配对是人照着规范的散文**手抄**进校验器的数组，两种错都
犯了 —— 第一版多列三对（把五个已发布主题全判挂），改完又漏了柱状图和折线图那几对
（九套配色全部违反而无人知晓）。中间那道手抄就是漏洞的来源。

`level: "soft"` 的条目里有一批**已知欠账**：规范和现有配色对不上，但修它要动色值或改
规范。跑 `node scripts/check-palettes.mjs --debt` 看全部，原委在每条的 `debt` 字段里。

不核的是**强调色块**的对比度：`.s-accent` 的色块、`.s-dot` 可以是**有意的低对比装饰**
（Editorial Forest 封面那个粉色圆章），不是缺陷。**强调文字不在此列** —— 这里原来写的是
「`.t-accent` 的大字是有意的低对比装饰」，那个豁免下错了：它只对封面那种 160px 的
`.t-display` 成立，而 visual-spec 的排行榜把**数值**写成 `.t-h2 .t-accent`，那是要读的数字。

### 深底配色要当心

`midnight` 是目前唯一的深底。主题和版式里凡是写着「背景是浅色，满屏 X 用整页形状做」的，
换到深底之后那句话就反过来了 —— 满屏深色**就是背景本身**，那个整页形状和背景糊在一起，
转场也看不出来。用深底配色时把那一页的整页形状改成浅色块。

### 2. 覆盖圆角和字体

- `--radius-s` `--radius-m` `--radius-l`：可以改小改大，`--radius-full` 不动。
- `--font`：必须带退路字体，最后要有能显示中文的字体（`"PingFang SC"` 或 `"Songti SC"`）。
  这一条不是防万一——库里的西文字体**根本没有中文字形**，中文永远落到这条退路上。
- **字体只用本地的**：文件开头写 `@import url("../fonts/fonts.css");`，不许再 `@import`
  Google Fonts。理由有三条，最要紧的是第三条：

  1. 断网或被墙时 `@import` 会阻塞渲染，首屏白一段；
  2. 字体晚到一帧，`capture.mjs` 录下来的就不是最终的样子；
  3. `runtime/fonts/` 里每个 `@font-face` 都带 `unicode-range`，把拉丁交给西文字体、
     中文交给退路里的 PingFang。**两边都拿到确定的字形，版面才不会跳** —— `.t-display`
     `.t-h1` 是 `nowrap` + 固定字号，规范里的文字宽度估算全建立在固定字形上，字宽一变就溢出。

  要用 `runtime/fonts/` 里没有的字体，先往 `scripts/fetch-fonts.mjs` 的 `FAMILIES` 里加一行，
  跑 `node scripts/fetch-fonts.mjs`，产物进仓库。**字重要把 400 也带上** —— 没套 `.t-*` 类的
  零散文字会落到基础字重，少一档浏览器就自己合成一个假的，笔画粗细和真字重对不上。

### 3. 调整五个字号类的字体、字重、行高、字距

`.t-display` `.t-metric` `.t-h1` `.t-h2` `.t-body` 可以改 `font-weight` `line-height` `letter-spacing`，
也可以改 `font-family`，但只能用主题里定义的字体变量（比如正文用 `--font-sans`，标题用 `--font`）。
**不许改 `font-size`**：规范里的文字宽度估算和页面坐标都建立在固定字号上。

### 4. 新增类（可选，最多 4 个）

只许新增这两种，而且只用变量里的颜色：
- **文字类** `.t-…`：换字体、大小写、字距，比如等宽小标签。字号不超过 `--type-body`。
- **形状类** `.s-…`：描边、特殊形状，比如描边圆章。

新增类里不许写位置、尺寸、动画、`transition`。每个新增类在文件开头注释里写一行：名字、样子、用在哪。

### 不许做的

- 不许改变量以外的布局规则（`.reveal .slides > section`、`.st-*` 这些类）。
- 不许在主题里给某一页、某个元素单独写样式。
- 不许改已有的主题文件来迁就某一份稿子。需要不同的样子就新建主题。

## 浅色主题的注意事项

- 遮挡剪辑写 `data-st-mask-color="bg"` 时，色块和纸面同色，效果是「内容被抹掉」。
- 想要满屏深色的页面（封面、章节页），不要改 `--bg`，用「整页 ↔ 卡片」组合里的整页形状（`transitions.md`）。
  这样深色页和浅色页之间还能用形态变换连起来。
- 深色形状上的文字一律加 `.t-on-surface`。
- `.t-metric` 自带强调色。放在浅色面板上时，强调色可能压不住底色，加 `.t-on-surface` 改成文字色。
