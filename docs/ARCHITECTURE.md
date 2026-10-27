# Architecture

决策和理由,**包括否掉了什么** —— 少了那部分,三个月后同一个问题会重新吵一遍。
改决策的办法:改这里,并在末尾变更表加一行。

---

## 形状

**本地 server 拥有全部状态和编排。每个客户端都是一个跑在类型化 WebSocket 之上的薄渲染层。**

```
Electron renderer                         薄客户端
        │  WebSocket,类型化契约
        │  req/res { id, method, params } · push { channel, sequence, data }
  core server(Node,本地,长驻,:6722)
        │  deck 状态 · 操作记录(JSONL) · 阶段状态机 · 待办队列 · 控制权
        └─ /mcp  Streamable HTTP ←── 你自己的 agent
```

**MCP 不是旁路,是同一套协议的第二个客户端。** 它和界面同进程、同端口,工具实现走
`ProtocolCaller` 调协议方法,不直接碰 server 内部状态 —— 这样「界面能做的每一件事都是
一个协议方法」这条不变量才检查得动(见 AGENTS.md 边界 3)。

_否掉:_ 单独的 MCP 进程 + 端口文件(多一个要启动、要发现、要对上版本的东西;既然应用
本来就得开着,挂在同一个端口上更简单)。

我们不驱动模型,也不管授权 —— 见「MCP 表面」。

为什么不直接写在 Electron 主进程里:

- **长活儿活得比窗口久。** agent 在它自己的宿主里,本来就不受这个窗口影响;server 独立出来,
  窗口关了它也可以不停。**现状和这条不符:** 壳在最后一个窗口关掉时就停 server
  (`apps/desktop/src/main.ts` 的 `window-all-closed`),MCP 跟着断。要不要让它活下去是待定项,
  见仓库根目录 `plan.md`。
- server 是无头的,编排逻辑不用起 Electron 就能测。
- 以后要 web 客户端也几乎免费。

**协议规则:** 两个方向的每个载荷都在边界上做 schema 校验。push 信封带每连接单调递增的
`sequence`,客户端据此发现丢帧并重同步。客户端传输层是显式状态机
(`connecting → open → reconnecting → closed`),断开期间排队出站请求。

_否掉:_ 全放 Electron 主进程(堵死 web 客户端)。线上用 tRPC(把客户端锁死在 TypeScript)。

---

## 桌面壳:Electron

macOS 与 Windows 共用一个 Chromium 渲染层,排版、文字、动效实现完全一致。这对本产品是硬
需求而不是偏好:**画布里跑的是用户最终要交付的那份 deck**,如果 macOS 跑 WebKit、Windows
跑 WebView2,同一份 GSAP 转场在两边不是同一个东西,「所见即所得」这句话就不成立。

Electron 偏弱的安全默认值在壳里补齐:`contextIsolation: true`、`nodeIntegration: false`、
sandbox、严格 CSP、窄的类型化 `contextBridge`、外部导航默认拒绝。渲染层永远不 spawn 进程、
不碰文件系统、不读凭证。

_否掉:_ Tauri / Wails(系统 webview 分叉,和上一段冲突)· 分别写 AppKit 和 WinUI(两套永久
UI 实现)· 纯 web 主客户端(拿不到本地文件、字体和导出)。

### 放映画布

**deck 预览跑在渲染层持有的 Electron `<webview>` guest 里,不是 iframe。** 附着之前主进程
剥掉 preload、分配独立持久 partition、关掉 node 集成,并强制 sandbox、context isolation 和
web security。顶层导航只接受 loopback HTTP —— deck 由本地 server 在 127.0.0.1 上服务。

### 放映画布怎么找资源

skill 做出来的稿子引的是 `../../node_modules/reveal.js/dist/reveal.js` 和
`../../runtime/tokens.css` —— **依赖在 deck 目录之外**。只服务 deck 目录的话,页面能打开
但没有 reveal、没有主题。

做法:**挂载路径直接镜像绝对文件路径** —— `/p/<token>` + `/Users/…/deck.html`。URL 里的
层数和磁盘上的层数一一对应,所以稿子里的相对引用在浏览器里解析出来的结果,和它在磁盘上
指向的东西完全一致,不管它往上跳两层还是八层。

能读的只有两个目录:这份 deck 自己,和 skill。之外一律 403 —— 这不是一个通用文件服务。
路径一律 realpath 之后再比对(macOS 的 `/var → /private/var` 这类软链会让纯字符串比对
把稿子自己的依赖判成越界),两边都要 realpath,只解析一边等于没解析。

同一份稿子复用同一个挂载 token:每次变动都换 URL 的话,画布只能整页重载(回到第一页),
旧挂载也会一直攒着。

_否掉:_ 改写稿子里的路径 —— 那样画布里跑的就不是用户交付的那份文件,「所见即所得」
立刻不成立,而且改写里的一个小错是隐形的。

_否掉(试过,是错的):_ 「按逃逸层数往上倒推一个公共服务根」。deck 和 skill 隔得远时
(`{{ROOT}}` 有七八层 `../`)根本推不上去 —— 推上去就等于把家目录挂出来 —— 于是深引用
全部落在挂载路径内部,一律 404。层数对齐没有这个问题。

选 `<webview>` 而不是 iframe 的原因是**它能被检视**:执行注入的检视脚本、拿元素几何、做
裁切截图,都要一个能被主进程当作独立 guest 管理的东西。iframe 在 CSP 和同源上会一路打架,
而检视正是本产品的核心交互。

---

### 缩略图与素材读取的资源上限

缩略图由桌面壳统一排队，最多同时存在一个离屏渲染窗口；同一目标只保留最新的等待请求，不同目标最多等待四个任务。渲染超过 45 秒或请求窗口关闭时销毁离屏窗口，成功与失败都会释放资源。被后续请求替代的任务返回空结果，页胶片沿用版本校验丢弃过期结果。

稿子提供 `__capture.go/seek` 时使用精确动画定位；普通 Reveal.js 稿子在隐藏窗口关闭内置转场、跳到目标页并显示全部 fragment 后截图。后者只提供静态页面缩略图，不保证任意自定义脚本动画的最终状态。图片解码最多等待 3 秒，可见画布不受影响。

素材内容哈希按流读取，同一文件版本的并发请求共享一次读取，不把大图或视频完整载入 Buffer。已完成的哈希按最近访问顺序最多保留 512 条；内容版本仍由文件内容决定。

### 当前画布检视

`canvas.inspect / canvas.select` 沿共享协议通过 Roundtrip 请求当前 Stage/guest，结果在边界上按契约校验。临时选区与运行时几何由 guest 提供，换页/重载即失效；稿子与控制权仍由 server 管理。意见队列与实时选区独立。

入口 HTML 原样服务，Server-Timing 响应头携带经过一致性检查的内容版本，guest 从导航 performance 条目读取。server 将当前内容版本与已加载版本分别返回；要求目标版本的请求等待加载并在返回时重新校验。未知版本、换稿、过期版本和超时有明确失败语义，不用重新读取源码冒充画布状态。

实现范围、验证与资源并发限制见 [画布检视计划](./CANVAS-INSPECTION.md)。

---

## 技术栈

|               |                             |                                     |
| ------------- | --------------------------- | ----------------------------------- |
| 语言 / 运行时 | TypeScript 5.9, Node 24 LTS | server、MCP、渲染层、壳共用一门语言 |
| monorepo      | pnpm workspaces + Vite      |                                     |
| 桌面          | Electron 43                 | 跨平台单一 Chromium                 |
| UI            | React 19                    |                                     |
| 样式          | CSS token 层                | 主题、密度、动效归 app 所有         |
| 操作记录      | JSONL,只追加                | `~/.orca-ppt/recording.jsonl`       |
| deck 运行时   | reveal.js + GSAP            | 来自 `skills/orca-ppt/`,原样复用    |
| 转场自检      | playwright-core,逐帧 seek   | skill 的 `capture.mjs`,出关键帧     |
| 测试          | Vitest                      |                                     |

---

## Deck 是一等领域对象

TasteCode 的领域对象是 thread;这里是 **deck**。

```
Deck
 ├─ brief          主题、受众、语气、时长、风格锚(来自参考库)
 ├─ theme          选自 runtime/themes,或新建的一份
 ├─ slides[]       每页:类型(版式)、主角、内容
 ├─ transitions[]  每次翻页一行:两页的关系 + 手法
 ├─ artifacts      渲染出的 HTML、录制的 mp4、逐帧证据
 └─ reviews[]      自检与人工意见,每条带锚
```

deck 存成**磁盘上的真实工程目录**,不是数据库里的 blob:

```
<deck>/
  deck.html            成品,浏览器直接能放
  .deck/brief.json     阶段产物,可检视
  .deck/theme.json
  .deck/plan.json      转场计划
  .deck/review/        截图、帧差量报告
  assets/
```

_为什么:_ 用户随时能把这个目录拿走,用别的 agent、别的编辑器继续干,产品不绑架内容。
这条和 orca-ppt-skill 现在的产物形态一致 —— 手工跑 skill 出来的目录,能直接被本产品
打开。

---

## MCP 表面

工具分两类,分界线是**要不要 agent 干活**。

**看与控**(agent 直接调,立刻生效):打开/新建 deck、读 deck 状态、跳到第几页、
拿产物路径、列主题、跑确定性校验、取某阶段的提示词。这些都对应界面上的一个动作,
反过来也成立。

**要 agent 干活的**(经待办队列):人在界面上取一处锚、点一个阶段的「跑」,都进队列;
agent 调 `take_requests` 取走,队列清空。

**阶段闸门仍然是闸门。** server 拥有状态机:`phase_prompt` 在上游产物不合规时直接拒绝
并说明哪条不合规,而不是把提示词给出去让 agent 自己看着办。方向从「我们推」变成
「它拉」,但门还在。

**授权不归我们管了。** agent 宿主自己有权限系统,我们不再造第二套 —— M3 那套
`canUseTool` 弹窗随适配器一起删掉了。这里交出去的只有**执行**:编排(阶段状态机)、
状态(deck 目录与操作记录)两样仍然在本地 server 手里。

**以后再遇到「要不要自己做 agent 入口」,按这两条判:** 我们的用户本来就坐在 agent 里,
宿主是现成的(TasteCode 必须自己驱动模型,是因为它自己就是宿主,没有别人的授权系统可以
交还);而且我们的写入作用域只有用户打开的那一份 deck 目录,授权面比通用 coding agent
小一个量级 —— 为这么小的面自建一套授权,性价比是负的。

_否掉:_ 适配器层(驱动各家 SDK、管会话、造一套授权 UI —— 那是在做通用 agent 客户端,
VISION 的非目标,而且每加一家引擎就要再写一个)· **自建一条直连模型的打分通道**
(哪怕只用来给关键帧打分:PPT 的不合格是人零点几秒就能判的,花一次模型调用又慢又不一定
对。自检的出路是确定性检查 + 界面标出来,见 DECK-MODE「自检回路」)。

---

## Deck Mode

产品的垂直闭环,细节在 [DECK-MODE.md](./DECK-MODE.md)。责任边界:

| server 运行时拥有      | `packages/deck-agent` 拥有 |
| ---------------------- | -------------------------- |
| 阶段编排、持久化、恢复 | 各阶段的提示词与产物契约   |
| `.deck/` 的落盘与重放  | 版式选择、转场手法判断规则 |
| 放映生命周期与截图捕获 | 自检标准与修复优先级       |
| 控制权与操作记录       | 什么情况下必须拒绝生成     |
| 待办队列与 MCP 表面    | 主题与配色的确定性校验     |

**运行时不是品味的来源。** 创作规则和确定性检查归 `deck-agent`,不许在 server 编排或 MCP
表面里复制一份。

---

## 交付形态:app + MCP + skill

**三件东西一起交付,同一个版本号。** app 是 Electron 壳加本地 server;MCP 是 app 自己挂的
`/mcp`;skill 在发布版里打进 app 的 `Resources/skill`,和 app 同一个版本。做法参照
ego-lite 浏览器:它的 CLI 和 skill 都在 app 包的版本目录里,升级时一起换。

为什么绑在一起:三件之间有接口约定 —— MCP 的工具名和说明、skill 的 `runtime/engine.js`
和画布里注入的检视脚本、`tags.json` / `pages.json` 的词表格式。分开发版就得维护一张兼容
矩阵;skill 改了 engine 或词表,老 app 就坏,而且坏得看不出原因。绑在一起,版本在结构上
就对得上。

server 找 skill 的顺序(`apps/server/src/skill.ts`):

1. `ORCA_PPT_SKILL` —— 显式指定,开发时拿来试 skill 的改动;
2. `ORCA_PPT_BUNDLED_SKILL` —— app 自带的那一份,壳在发布版里设;
3. 开发时读仓内的 `skills/orca-ppt/`,再往后是并仓之前的老位置(ghq 路径、旧的安装位置)。发布包内置目录缺失时直接报告 missing，不回退其他版本。

**`skills/orca-ppt/` 是规范内容的唯一来源。** 2026-10-10 起 skill 带着历史并进本仓(原 `orca-ppt-skill`),
按 skill 仓库的惯例放在 `skills/<名字>/`,想单独给 agent 用就把这个目录链进它的 skills 目录;
打包时从同一个提交取出它放进安装包。代价不变:改一处转场规范也要发一次 app。

_否掉:_ skill 独立更新、app 读最新的那份(之前的做法,理由见上:接口一变老 app 就坏)·
app 运行时从网上拉 skill(多一条网络依赖,版本照样对不上)。

**(已作废,2026-10-10)不单独分发 skill,也不往 agent 的 skills 目录链。** agent 一律通过
MCP `read_skill` 读同一版本的规范。下面是作废前的设计,留着备查。

**把 skill 交到 agent 手里要先问人,而且只链两处:`~/.agents/skills` 和 `~/.claude/skills`。**
前者是通用约定(Codex 等从这里读),后者是 Claude Code。首次引导时说清会写这两处,人点头才链。
往用户的 agent 配置里写东西,是用户该点头的事。

软链分三层,学 ego:

```
~/.agents/skills/orca-ppt ─┐
~/.claude/skills/orca-ppt ─┴→ ~/.local/share/orca-ppt/skill      (稳定路径,永远不变)
                                 → <当前版本的 app>/Resources/skill
```

升级只换最后一根,前两根不动;新旧版本并存时还能回退。

_否掉:_ ego 的做法 —— 引导时不问,把软链撒进本机六十来个 agent 目录,连没装的 agent 也替它
建一个只有 `skills/` 的空目录(实测:`~/.moxby`、`~/.jazz`、`~/.bob` 都是这样来的)。
两处已经覆盖主流宿主,其余的用户自己要再链。

**还没做:**

- 正式发布签名、公证和发布版本号管理（当前打包输出用于本地验收）。
- 首次引导本身(连同上面那一步询问)。

---

## 一个内核,三种形态:桌面、本地 Web、CLI

**目标形态,还没实现。** 同一个内核同时撑起 Electron 界面、浏览器里的本地工作台和不开界面
的 CLI。WorkBuddy 这类 agent 装好 CLI 和 skill 就能新建、改写、检查、导出;人想看、想指给
AI 看,再开桌面版或 `orca-ppt serve`。

**Web 版只做本地。** 没有云端稿子、没有线上工作台:server 永远跑在用户自己的机器上,
稿子永远是磁盘上的目录。上面「否掉:纯 web 主客户端」那条依旧成立 —— 本地 Web 版的 server
还在本地,拿得到文件、字体和导出,否掉的是把 server 也搬走。

```
┌──────────── 内核(纯库,不起进程、不持有状态)────────────┐
│ deck-agent   品味:阶段提示、产物校验、spec-check、配方提示  │
│ deck-core    机械:新建/实例化、找入口、切页、改字、改页、    │
│              模板/主题/同款列表、阶段状态、预览路径规划       │
│ Renderer     接口:截单页 / 缩略图 / 导 PPTX / 录视频         │
└────────────────────────────────────────────────────────┘
        ▲                          ▲
   CLI 直接调                server(有状态:打开的稿子、撤销、控制权、
  (批量、无界面)              操作记录、文件监听、协议、/p、/mcp、托管界面)
                                   ▲ WebSocket 协议
                     ┌─────────────┴─────────────┐
                Electron 界面                浏览器界面
          (同一份 apps/web,差别只在 Host 和 CanvasDriver)
```

### 四个接缝

**`deck-core`。** 现在 `apps/server/src` 里只吃路径的纯函数搬出来:`templates.ts`、
`recipes.ts`、`phases.ts`、`decks.ts`、`page-edit.ts`、`edit.ts`;`spec-check.ts` 是确定性
检查,按「Deck Mode」那张表归 `deck-agent`。内核包不 import `electron` / `ws`,不持有进程级
状态 —— 撤销历史、控制权、操作记录是「有人在场协作」才有的东西,留在 server。

**`Renderer`。** 所有「开一个浏览器把稿子渲出来」的活走一个接口。样板已经在 skill 里:
`scripts/lib/pptx-export.mjs` 的 `exportDeck(page)` 只依赖 `evaluate` + `screenshot`。

- playwright + 系统 Chrome 一份,给 CLI 和 `serve` 用(即 `capture.mjs` / `export-pptx.mjs`
  现在的做法);
- Electron 隐藏窗口一份,给桌面版用(即 `pptx-exporter.ts` / `thumbnail-queue.ts`)。server
  跑在 `utilityProcess` 里,经 parentPort 直接找主进程要,不再绕界面。

server 启动时注入其一。现在 `pptxExports` / `thumbnails` 那两个 Roundtrip 广播给界面、界面
再转给壳,界面不在就失败,改完就没有这个依赖了。**例外是 `capture_slide`:** 它的语义是
「人此刻在画布上看到的那一页」,有界面连着时照旧走界面;没有时退回 Renderer 无头截。

**`Host`。** 取代 web 里直接调的 `window.orca`,只剩真正的壳能力:

| 能力                 | Electron                  | 浏览器                                              |
| -------------------- | ------------------------- | --------------------------------------------------- |
| 选稿子目录           | 原生对话框                | 最近打开 + 填路径(不在 server 里分平台弹系统对话框) |
| 放映                 | 新窗口,盖住菜单栏         | Fullscreen API                                      |
| 菜单、红绿灯、主题   | 有                        | 没有或页内替代                                      |
| 裁切图、缩略图、导出 | 走协议,server 调 Renderer | 同左                                                |

**`CanvasDriver`。** 取代 `Stage.tsx` 里直接用的 `<webview>`,只有 `eval`、`load`、
`onNavigate`、注入 guest 脚本这几个动作,Stage 其余逻辑不动。

- `WebviewDriver`:现在的写法。
- `IframeDriver`:server 同时托管界面和 `/p`,两边**同源**,直接经 `contentWindow` 调
  `__orcaCanvas` / `__orcaEdit`,guest 脚本用 `<script>` 塞进去。上面「放映画布」否掉 iframe
  的理由是 CSP 和同源上打架,同源之后不成立;webview 照旧是桌面版的选择。

### 三种形态怎么拼

- **桌面版**:Electron 起 server、注入 Electron Renderer;界面用 `ElectronHost` +
  `WebviewDriver`。行为和现在一样。
- **`orca-ppt serve`**:同一个 server 入口,注入 playwright Renderer,多托管一份
  `apps/web` 的打包产物,打开浏览器;界面用 `BrowserHost` + `IframeDriver`。**浏览器能连上来
  之前必须先补 Origin 校验和启动 token**(token 放在打开的 URL 里):现在 `server.ts` 的
  WebSocket 不校验来源,只有 Electron 连还好,放给浏览器之后,用户开着的任何网页都能连
  `ws://127.0.0.1:6722` 改稿子。
- **CLI**:直接调 `deck-core`、`deck-agent` 和 playwright Renderer,不经过 server。和界面的
  同步靠**磁盘**:CLI 写了 `deck.html`,开着的桌面版或 `serve` 由 `deck-watch.ts` 发现并刷新
  画布,CLI 不需要知道有没有 server 在跑。

分发:一个 `orca-ppt` 包,里面有 CLI、server、web 打包产物、skill,同一个版本号。桌面 app
把同一个包放进 Resources,像 ego-lite 那样把 CLI 也露出来 —— 和「交付形态」那节「三件
一起发版」是同一个道理,只是多了一个不带壳的入口。

### 规则

1. 内核只吃路径、只返回值。
2. server 不 import `electron`,渲染一律走 `Renderer`。
3. `apps/web` 只经 `Host` 和 `CanvasDriver` 碰外界。
4. CLI 是**库客户端**,不走协议,但它能做的操作协议里必须也有 —— AGENTS.md 边界 3 的延伸,
   防止 CLI 长出界面和 MCP 都没有的能力。

### 顺序

1. 搬出 `deck-core`(spec-check 进 `deck-agent`),server 改成调它,行为不变。
2. 抽 `Renderer`,server 去掉对界面的 pptx / 缩略图 Roundtrip。
3. web 里抽 `Host` 和 `CanvasDriver`。
4. `serve`:托管界面,Origin 校验 + token。
5. CLI。

前两步做完桌面版行为不变,内核已经不依赖界面;CLI 和 `serve` 只是在外面再加一层。

**稿子引运行时走一个稳定路径。** 稿子现在用相对路径指回 skill 的安装位置(`templates.ts`
的 `{{ROOT}}` 改写)。应用里 skill 跟着 app 走看不出来;CLI 一升级换了目录,老稿子就全白。
做法:CLI 和桌面版都把当前版本的 skill 链到同一个稳定路径(如 `~/.local/share/orca-ppt/skill`,
和上面作废的软链设计是同一个位置),`{{ROOT}}` 改写成指向它的相对路径。升级只换链接,
稿子不动;谁建的稿子都指向同一处。代价:老稿子跑新引擎,`engine.js` 对稿子 HTML 要向后
兼容 —— 这和应用里升级 skill 的现状一样,不是新负担。

稳定路径按平台定:

| 平台    | 位置                            | 链接                                                  |
| ------- | ------------------------------- | ----------------------------------------------------- |
| macOS   | `~/.local/share/orca-ppt/skill` | 软链                                                  |
| Windows | `%LOCALAPPDATA%\OrcaPPT\skill`  | 目录 junction(软链要管理员或开发者模式;junction 不要) |

server 比对路径前一律 realpath(见「放映画布怎么找资源」),软链和 junction 都会被解析成
当前版本的真实目录,预览照常放行。

**稿子和 skill 必须在同一个盘上。** Windows 上 D 盘的稿子没有相对路径能指到 C 盘的 skill:
`path.relative` 跨盘时直接返回 `C:\…` 这样的绝对路径,写进 href 成了 `C:/…`,浏览器把
`C:` 当成协议名,资源全白,入口页照样 200。新建稿子时检测到跨盘就直接拒绝,说清两个盘符;
不写成 `file:///C:/…` —— 画布是 http 页面,加载不了 `file://` 子资源。

**ffmpeg 不是必须依赖。** `capture.mjs` 默认只做转场自检:逐帧 seek,出每页的关键帧、每次
转场动了几帧、页面自报的问题,不拼视频;`-o x.mp4` 才调 ffmpeg,没装就说清怎么办。CLI 的
「过一遍转场」就是它。`capture` / `export-pptx` 要系统 Chrome,怎么交到新手手里,CLI 对外发
之前要定。Windows 上很多机器只有 Edge,浏览器按 `chrome` →
`msedge` 的顺序找。浏览器版的「选目录」两边都先做「最近打开 + 填路径」,不在 server 里分
平台弹系统对话框。CLI 单文件分发时,macOS 要签名和公证,Windows 要代码签名、过 SmartScreen,
各一套。

_否掉:_ 线上 / 云端 Web 工作台(稿子要么搬进云端存储,违反「deck 是磁盘上的目录」;要么
公网页面连本机 server,浏览器的本地网络访问限制加上一套授权,换来的只是不用装)·
CLI 走 server(那就又得先把应用开着,正是要去掉的前提)· 运行时引 CDN(主题和字体不在
CDN 上,离线就坏)· **每份稿子自带一份运行时**(引擎、reveal、GSAP、主题拷进稿子目录:每份
多出十来 MB 的打包产物;更糟的是稿子各带各的旧引擎,画布检视脚本得兼容所有出过的
`engine.js` 版本,兼容矩阵又回来了 —— 换来的「拿走即用」现在不需要)。

---

## 变更表

| 日期       | 变更                                                                                                                                                                                                                                                             | 理由                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-20 | 初版。Electron 壳 + 本地 server + Claude Code/Codex 双适配器                                                                                                                                                                                                     | 见各节                                                                                                                                                                                    |
| 2026-09-20 | 放映画布的服务根按稿子实际逃逸层数倒推,不改写稿子                                                                                                                                                                                                                | skill 的稿子把依赖放在 deck 目录之外                                                                                                                                                      |
| 2026-09-20 | 删掉适配器层与授权 UI,换成 MCP server:只交出执行,不交编排和状态                                                                                                                                                                                                  | 适配器就是在做通用 agent 客户端,而那是非目标;走 MCP 则任何支持它的 agent 都能用                                                                                                           |
| 2026-09-20 | 放映画布改成挂载路径镜像绝对文件路径,推翻上面那条「按逃逸层数倒推公共根」                                                                                                                                                                                        | deck 和 skill 隔得远时根本推不上去,深引用全部 404;层数一一对应就没有这个问题                                                                                                              |
| 2026-09-20 | MCP 挂在 server 自己的 `/mcp`(Streamable HTTP),不单独起进程                                                                                                                                                                                                      | 少一个要启动、要发现、要对版本的东西;应用本来就得开着                                                                                                                                     |
| 2026-09-20 | 改名 orca-pptcode → orca-ppt(包名、环境变量、MCP 名、仓库全跟着改)                                                                                                                                                                                               | 「code」暗示 coding agent 客户端,而那是 VISION 最硬的一条非目标;名字得跟架构走                                                                                                            |
| 2026-09-20 | 不做录制导出。预览靠方向键和自动播放,交付物是稿子不是视频                                                                                                                                                                                                        | 演示稿的交付物是稿子本身;看效果放一遍就有,不需要先出一段几分钟才录完的视频                                                                                                                |
| 2026-09-20 | 自动播放放在观看端(注入 guest),不进 engine.js                                                                                                                                                                                                                    | 自动播放是看的人的选择,不是稿子的属性;同一份稿子在浏览器里仍然手动翻页                                                                                                                    |
| 2026-09-20 | 自检回路暂不做:agent 触发,人给反馈                                                                                                                                                                                                                               | 人指一下就说清了,自动 critique 是为了省那一下 —— 而那一下本来就不费事                                                                                                                     |
| 2026-09-20 | 定位:先是给人用的工作台,MCP 只是把操作接口开放给 agent 代为执行                                                                                                                                                                                                  | 产品不绕着 agent 转;所以界面上不该有「只有 agent 在场才生效」的东西                                                                                                                       |
| 2026-09-20 | 界面上不出现「待办队列 / 等 agent 来取」:人本来就在跟 agent 说话,点一下是指给它看                                                                                                                                                                                | 那个环节在用户脑子里不存在,写出来只会让人以为还要做点什么                                                                                                                                 |
| 2026-09-20 | 自检只做确定性检查,产出锚并在界面上标出来,不自动修                                                                                                                                                                                                               | 目标不是全自动。PPT 的不合格人一眼能判,render → critique → revise 里的 critique 归人                                                                                                      |
| 2026-09-24 | skill 跟着 app 发版,打进安装包;推翻「skill 更新产品跟着更新,不两边同步」                                                                                                                                                                                         | 三件之间有接口约定,分开发版要维护兼容矩阵,skill 一改老 app 就坏;参照 ego-lite                                                                                                             |
| 2026-09-24 | 自带的 skill 链进 agent 的 skills 目录之前先问人,只链 `~/.agents/skills` 和 `~/.claude/skills`                                                                                                                                                                   | 往用户的 agent 配置里写东西是用户该点头的事;不学 ego 往几十个目录撒软链、替没装的 agent 建空目录                                                                                          |
| 2026-10-10 | skill 目录按惯例挪到 `skills/orca-ppt/`                                                                                                                                                                                                                          | `skills/<名字>/SKILL.md` 是 skill 仓库的通行布局,用户直接链这个目录就能单独用                                                                                                             |
| 2026-10-10 | skill 带历史并进本仓 `skill/`;不再单独分发;整个仓库在原 skill 仓上开源                                                                                                                                                                                           | 同款画廊这类改动总是界面和规范一起动,分仓只剩手推 skill-lock 和跨仓对齐的成本;发布版本来就绑在一起                                                                                        |
| 2026-10-26 | 删掉演示模式(菜单「放映 › 演示模式」、`set_demo_mode`、`demo.set` / `demo.state` / `demo.changed`、`edit.follow` 的 `holdMs`)。改动框固定留 1.6 秒                                                                                                               | 当初为录屏加的,鲸录从没用过:节奏在后期剪(剪停顿、补定格、按 uiTargets 推近),不靠应用排队放慢;放在「放映」下还容易被当成第三种放映方式                                                     |
| 2026-10-26 | 改动框:agent 每改一处,画布上框出那一处并带一个说在做什么的标签(改文字、换图片、重写这一页…),整页改动框整页;撤销重做不管谁发起都走同一条 `edit.follow`。框画在宿主页面、webview 之上,不进稿子 DOM;删掉 guest 里的 outline 点亮和攒到下次加载的 `pendingSpotlight` | 只翻页、闪一下 outline,看录像的人分不出 agent 改的是标题还是说明;框画进稿子 DOM 会被 `capture_slide` 截进去,干扰 agent 自检;撤销已改成就地换页,攒到下次加载的点亮再也等不到               |
| 2026-10-25 | 修复 agent 的改动在界面上看不到:经 MCP 的写操作在串行队列里等画布跟上(翻页、框出、确认上屏)再做下一条,常开;改字就地换不整份重载。新功能 `studio.orca/ui-targets` v1(resolve_ui_targets、回执和操作记录里的 uiTargets),删 `visual_target`。可选:演示模式,默认关   | agent 几十条改动几十毫秒做完、被改的页不在画面上,看着的人只觉得「说改好了却什么都没变」,提示词约束不住。MCP 调用不带位置,录屏要加标注只能由应用报出来;节奏由录屏方后期补,不要求应用加模式 |
| 2026-10-25 | 只改了几页时画布只换那几页,不整份重载:server 按页比对两版推 `deck.patched`,稿子的 engine 加 `__orcaReplaceSlide`(重做那一页的准备 + `Reveal.sync`/`syncSlide`);新增 `read_page` / `write_page`。稿子仍是一份 HTML,不拆文件                                       | 整份重载画面白一下、转场状态全丢。拆成多个文件会断掉跨页转场(要在同一个 DOM 里配对)、双击打开(`file://` 拉不到别的文件)和「目录拿走能接着用」;reveal 本来就支持改 DOM 后 sync             |
| 2026-10-27 | 新增「一个内核,三种形态」:内核拆成 `deck-core` + `deck-agent` + `Renderer` 接口,web 抽 `Host` / `CanvasDriver`,加 `orca-ppt serve` 和 CLI;Web 版只做本地;稿子经稳定路径引运行时,不自带一份(目标形态,未实现)                                                      | 让 agent 不开应用也能新建、检查、导出;人在浏览器里也能看稿和指给 AI 看。不做云端:稿子必须留在本地磁盘                                                                                     |
| 2026-10-27 | `capture.mjs` 默认不出视频:出关键帧(每页转场 5 帧 + 停稳 1 帧,写到系统临时目录)和每次转场动了几帧,动的不到一半就提醒;`-o x.mp4` 才拼视频。SKILL.md 第 7、8 步改成看关键帧                                                                                        | ffmpeg 不该是必须依赖:新手机器上多半没有。自检要的是关键帧和「转场动没动」,mp4 只是载体;agent 多半放不了视频,本来就是抽帧看。关键帧不写进稿子目录,应用在监听那里                          |
| 2026-09-24 | 事件日志落成 JSONL(`~/.orca-ppt/recording.jsonl`),不用 SQLite;删掉「录制 job」的残留说法                                                                                                                                                                         | 要的只是追加和按游标顺序读,万条级,没有查询;一行一条零依赖、坏行能跳过、人能直接看。录制导出 09-20 已否掉                                                                                  |

### 已实现的打包和按需读取

`pnpm package` 构建桌面、server 和网页，使用 Electron Packager 输出当前平台应用到 `release/`。skill 取自当前提交的 `skills/orca-ppt/`（`git archive HEAD:skills/orca-ppt`），忽略工作区修改，并按 skill 的 package-lock.json 安装生产依赖。`Resources/skill/bundle-manifest.json` 记录应用版本和提交。

MCP 的 `list_skill` / `read_skill` 按相对路径提供随附规范文本。它们走 contracts 的 skill.list / skill.read，支持分页并拒绝越界路径及外部软链。阶段提示词引导宿主调用这些工具，不要求它拥有文件工具。此读取路径不安装全局 Skill、不写宿主配置；上述软链安装仍是可选且未实现的引导。图片/视频资料暂不由 read_skill 返回；应用截图继续走 capture_slide。

## 共享基础编辑

产品实施顺序见 [Agent Native PPT 计划](./AGENT-NATIVE-PRODUCT-PLAN.md)。

`deck.editPages` / `deck.replaceImage` 与原有改字和撤销走同一 contracts/server/MCP 链路，UI 只是客户端。结构操作通过 parse5 的源码位置移动完整 section，避免浏览器 DOM 重新序列化和脚本中的伪标签误计数。现有 brief 页数、大纲、转场元数据进入同一条历史；新增页不编造内容决策，版式理由留空等待补充。

共享写操作按 deck 串行执行。结构和图片操作绑定内容版本，撤销时精确校验关联文件；改字仍保留只反向替换原文的外部修改容忍方式。文件改动先暂存再替换，异常时尽可能还原仍匹配的已写文件，不提供跨文件崩溃原子性。明确限制见产品计划和 MCP 文档。
