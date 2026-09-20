# Architecture

决策和理由,**包括否掉了什么** —— 少了那部分,三个月后同一个问题会重新吵一遍。
改决策的办法:改这里,并在末尾变更表加一行。

---

## 形状

**本地 server 拥有全部状态和编排。每个客户端都是一个跑在类型化 WebSocket 之上的薄渲染层。**

```
Electron renderer        MCP server        两个薄客户端
        │                     │  stdio ←── 你自己的 agent
        │  WebSocket,类型化契约
        │  req/res { id, method, params } · push { channel, sequence, data }
  core server(Node,本地,长驻)
           deck 状态 · 事件日志(SQLite) · 阶段状态机 · 待办队列 · 录制 job
```

我们不驱动模型,也不管授权 —— 见「MCP 表面」。

为什么不直接写在 Electron 主进程里:

- **长活儿活得比窗口久。** 关掉窗口,录制 job 还在跑;agent 在它自己的宿主里,本来就不
  受这个窗口影响。
- server 是无头的,编排逻辑不用起 Electron 就能测。
- MCP server 是同一套协议的第二个客户端,不是旁路。以后要 web 客户端也几乎免费。

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

## 技术栈

|               |                             |                                     |
| ------------- | --------------------------- | ----------------------------------- |
| 语言 / 运行时 | TypeScript 5.9, Node 24 LTS | server、MCP、渲染层、壳共用一门语言 |
| monorepo      | pnpm workspaces + Vite      |                                     |
| 桌面          | Electron 43                 | 跨平台单一 Chromium                 |
| UI            | React 19                    |                                     |
| 样式          | CSS token 层                | 主题、密度、动效归 app 所有         |
| DB            | Node SQLite, WAL            | 追加式事件 + 可重建读模型           |
| deck 运行时   | reveal.js + GSAP            | 来自 orca-transition-skill,原样复用 |
| 录制          | playwright-core,逐帧 seek   | 同上,`capture.mjs` 包成 job         |
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
这条和 orca-transition-skill 现在的产物形态一致 —— 手工跑 skill 出来的目录,能直接被本产品
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
状态(deck 目录与事件日志)两样仍然在本地 server 手里。

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
| 录制 job 与重试预算    | 什么情况下必须拒绝生成     |
| 待办队列与 MCP 表面    | 主题与配色的确定性校验     |

**运行时不是品味的来源。** 创作规则和确定性检查归 `deck-agent`,不许在 server 编排或 MCP
表面里复制一份。

---

## 变更表

| 日期       | 变更                                                            | 理由                                                                                 |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 2026-09-20 | 初版。Electron 壳 + 本地 server + Claude Code/Codex 双适配器    | 见各节                                                                               |
| 2026-09-20 | 放映画布的服务根按稿子实际逃逸层数倒推,不改写稿子               | skill 的稿子把依赖放在 deck 目录之外                                                 |
| 2026-09-20 | 删掉适配器层与授权 UI,换成 MCP server:只交出执行,不交编排和状态 | 适配器就是在做通用 agent 客户端,而那是非目标;走 MCP 则任何支持它的 agent 都能用      |
| 2026-09-20 | 自检只做确定性检查,产出锚并在界面上标出来,不自动修              | 目标不是全自动。PPT 的不合格人一眼能判,render → critique → revise 里的 critique 归人 |
