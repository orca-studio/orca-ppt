# MCP

orca-ppt 先是给人用的。**MCP 把它的操作接口开放出去,让 agent 代你执行** ——
不是产品绕着 agent 转。

## 为什么

VISION 写明不做通用 agent 客户端 —— 那是 TasteCode。但适配器层(驱动 SDK、管会话、
造一套授权 UI)恰恰就是在做那件事,而且每加一家引擎就要再写一个适配器。

走 MCP 这笔账直接消失:任何支持 MCP 的 agent 都能用。省下来的力气全部投进只有 GUI 能做的
那部分 —— 放映画布、检视锚、阶段栏、产物。

## 形状

```
Electron 界面  ──┐
                 ├── 类型化 WebSocket ──→ 本地 server(拥有全部状态)
MCP adapter   ──┘                            ↑
   ↑ HTTP /mcp                                   │
你的 agent                          deck 目录 · 预览 · 阶段状态机 · 待办队列
```

MCP server 自己**不拥有任何状态**,全部转给本地 server —— 也就是界面连的那一个。
人和 agent 看到的因此永远是同一份 deck。

## 不变量:与界面等价

**界面能做的每一件事都是一个协议方法。** 界面里有、协议里没有的操作,不许存在,哪怕它
「只是本地的」,比如跳到第几页。

两个方向都要成立:agent 说「你看第 4 页」画布得跳过去,人点页胶片 agent 也得知道。
走同一套方法才不会分叉成两个半残的产品。

## 工具

**看与控** —— 直接调,立刻生效:

| 工具                        | 对应界面上的             |
| --------------------------- | ------------------------ |
| `open_deck` / `create_deck` | 打开 / 新建              |
| `deck_status`               | 阶段栏和页胶片显示的那些 |
| `show_slide`                | 点页胶片                 |
| `edit_text`                 | 双击一处文字改掉         |
| `edit_plan`                 | 改转场计划注释里的一句   |
| `show_recipe_prompt`        | 点同款卡片上的「做同款」 |
| `artifact_path`             | 「看产物」               |
| `check_phase`               | 阶段栏上的红字           |
| `phase_prompt`              | 点「跑」之后该做什么     |
| `capture_slide`             | 人眼看画布的那件事       |
| `list_themes`               | 主题目录                 |
| `export_pptx`               | 文件 › 导出 PPTX…        |

`edit_text` 和界面上的双击改字是同一条路:按**旧文字**在那一页的源码里定位,只换文字,
标签和属性一个不动。找不到、或者一页里有好几处一样的,就拒绝并说明理由 —— 不猜着改,
静默毁掉一个 `data-carry` 会让转场哑掉,而且要等到放映才发现。
转场计划注释在页面之外,`edit_text` 够不着,用 `edit_plan`,规则一样。

**`capture_slide` 是这套东西里最要紧的一个。** 稿子好不好只有放映能回答 —— 光读 HTML
看不出一页挤不挤、转场对不对得上。有了它,agent 改完能**自己看一眼**,而不是闭着眼改、
等人来描述。这也是只有「应用开着」才做得到的事,正是我们存在的理由。

## 当前画布检视

| 工具                    | 用途                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `get_canvas_context`    | 当前页、实时选区、加载/播放状态、内容与渲染版本            |
| `get_canvas_elements`   | 当前页元素、页内选择器、设计坐标几何与可见性               |
| `get_canvas_html`       | 当前页运行时 DOM，最多 100000 字符，不含 Canvas/WebGL 像素 |
| `get_canvas_errors`     | 当前画布捕获到的加载、脚本、资源和 Promise 错误            |
| `select_canvas_element` | 按选择器、页号和版本选择/取消选择，并持续高亮              |

右栏「页」中的「选择画布元素 / 取消选择」走相同的 `canvas.select` 协议。
实时选区与 `user_selection` / `peek_selection` 的意见队列独立，读取现场不会清空意见。
元素选择器只在返回的页号与版本范围内有效，换页或重载后重新读取。

读取工具可传 `expected_revision` 等待画布加载指定版本；内容已变化则返回 `STALE_REVISION`，
加载超时返回 `RENDER_NOT_READY`。不传时检查 `current`，false 表示当前画面未确认最新内容。
`capture_slide` 可传同一参数，返回的文字附带实际 `deckId`、`slide` 和 `renderedRevision`，图片仍内联。
推荐流程：`deck_status` 取得改后版本 → `get_canvas_context(expected_revision)` → `capture_slide(expected_revision)`。

详细边界与后续计划见 [画布检视实施计划](./CANVAS-INSPECTION.md)。

## agent 做的事要看得见

**agent 是代替人执行的,那它做的事就该和人做的一样看得见。** 画布自己翻了页、文字自己
变了,人不该只能干看着猜是谁干的。

每次工具调用推两条 `mcp.activity`:**跑之前**一条 `start`,跑完一条 `done`。读也要先
announce —— `capture_slide` 会把画布跳到另一页,不先说一声的话人是懵的。

每条带着 `kind`(读还是写)、`label`(人话,直接显示)、`slides`(涉及哪几页)。界面据此:

- 页胶片上把那几页圈出来。**读一圈淡边、写一圈实边加底色** —— 读是「它正在看这儿」,
  看完就过去了;写是「这儿被改了」,人得有时间把视线移过去看清,所以留得更久。
- 状态栏显示它此刻在做什么。没动静时那块是空的 —— 常驻一行字只会变成背景噪音。
- 工具拒绝了(`isError`)就显示成没办成,理由原样摆出来。报成功是不诚实的。

说不准是哪一页时(比如截「当前这页」)`slides` 就是空的 —— 宁可不高亮,也别高亮错的那页。

**这件事成立的前提是那条不变量**:UI 的操作接口就是协议方法,agent 走的是同一批方法。
所以 server 是唯一的咽喉,agent 干的每件事都从它过。反过来说,agent 要是绕开 MCP、
用自己的读写文件工具直接改 HTML,这里就什么都看不到 —— 只有文件 watcher 会说「变了」,
说不出是谁改的、改了哪儿。

截图落在应用自己的数据目录，MCP 同时返回图片内容；只有读取图片失败时才退回路径。server 截不了图(画布在壳
里),所以是一个往返:server 推 `capture.request` → 壳截 → 壳调 `capture.result`。
壳不回话就超时失败,不把 agent 吊死。

**要 agent 干活的** —— 经待办队列:

| 工具             | 做什么                              |
| ---------------- | ----------------------------------- |
| `user_selection` | 取走用户挂起的锚和阶段请求,取完清空 |
| `peek_selection` | 同上但不清空                        |

## 方向:人推不动 agent,所以 agent 来拉

MCP 没有可靠的「把消息推进用户对话」的原语。notification 能说「有东西变了」,但不保证
正在跑的 agent 会去看。与其假装能推,不如把方向摆明:

人在画布上点一处 → 挂进待办队列,界面显示「已挂 N 件,跟 agent 说一声」→
用户说「看我刚点的那处」→ agent 调 `user_selection` 拿到页号、选择器、1920×1080 设计
坐标和一张裁切图。

代价是从一步变成两步。坐标照样准确传过去 —— 那才是核心价值。

## 闸门仍然是闸门

`phase_prompt` 在上游产物不合规时**直接拒绝**并说清哪一条,而不是把提示词给出去让 agent
自己看着办。server 拥有状态机,方向只是从「我们推」变成「它拉」。

## 授权

不归我们管。agent 宿主自己有权限系统,我们不造第二套。

## 装

应用开着的时候,MCP 就挂在 `http://127.0.0.1:6722/mcp` 上。

```bash
claude mcp add --transport http orca-ppt http://127.0.0.1:6722/mcp
codex mcp add orca-ppt --url http://127.0.0.1:6722/mcp
```

Cursor 手动加进 `~/.cursor/mcp.json`:

```jsonc
{ "mcpServers": { "orca-ppt": { "type": "http", "url": "http://127.0.0.1:6722/mcp" } } }
```

应用菜单「帮助 > 连接 AI 助手…」不给命令,给的是一句发给助手的话(读 `llms.txt`,自己连上),
各家怎么加 MCP 写在 `site/src/llms.txt` 里。不配 MCP、不装桌面版的那条路(npm 包 + 浏览器工作台 +
`orca-ppt` 命令)写在 `site/src/llms-web.txt`。

**为什么是 HTTP 不是 stdio:** stdio 要在 agent 配置里写一条指向本仓 `dist` 的路径
(打包之后就废了),还要多起一个进程、再想办法告诉它连哪个端口。HTTP 只要一行,而且
MCP 就住在 server 进程里 —— 工具调的就是界面调的那批方法,不经过第二条连接。

**端口是固定的**(`ORCA_PPT_PORT` 可覆盖)。安装命令里写死了这个 URL,端口一变命令
就失效,所以不能用随机端口。被占了就如实失败 —— 多半是已经开着一个实例,那正是我们想要
的。

应用没开的时候 MCP 连不上,这是对的:画布在应用里,没有应用就没有可看的东西。

## UI 与 MCP 的操作对齐

`list_templates` 返回 UI 新建窗口使用的模板目录。`create_deck` 接受 `parentDir`、`title`，以及可选的 `from` 模板 ID 和 `theme` 主题名，直接调用同一个 `deck.create`。省略 `from` 时仍创建空目录，保持原有行为。

`deck.current` 是当前打开稿子的协议状态。MCP 首次使用它确定目标，后续保持目标绑定；用户在 UI 切换稿子后，返回 `DOCUMENT_CHANGED`，必须确认目标后显式 `open_deck`，不会自动将旧任务转向新稿。`deck_status` 返回 `deckId` 和 `currentSlide`（从 0 数起；画布尚未报告时为 null）。

`navigate` 支持 `next`、`previous`、`replay`、`replayPage`。`next` 在有点击分步（`data-step`）的页上先放下一步，全部放完才翻页；`replay` 重放从 `from` 页翻到下一页的转场，`replayPage` 把 `from` 页的页内动画从头放一遍，两者都必须带 `from`。UI 键盘导航和重放同样调用 `deck.navigation`，由服务端停止自动播放并通知画布执行。画布完成翻页后通过 `deck.visibleSlide` 报告实际页号；请求成功不等于动画已经结束。旧稿子的导航请求被拒绝，旧画布的页号报告不会覆盖当前稿子。

这是现有操作入口的一致性改进，不代表已经实现完整的手工排版、增删页或通用导出功能。

## 随附规范

先调用 `read_skill`（默认 `SKILL.md`）；引用资料通过 `list_skill` 浏览，再按相对路径 `read_skill`。目录每页 100 项，文本每页 6000 个 Unicode 字符；返回 `next` 非空时继续传入 `offset`。单文件上限 2 MB，仅支持文档、JSON、HTML/CSS/脚本等文本。不能读任意本机文件，不能通过软链逃出 Skill 根目录；图片和视频不由此接口提供。无需打开稿子。`doctor` 可确认当前 Skill 来源是否 bundled。

## agent 的改动要在界面上看得见

### 修复:agent 的改动在界面上看不到

agent 经 MCP 改了稿子,界面上却看不出改了什么、改在哪。它并发发调用,几十条改动几十毫秒就做完,
被改的页又多半不在画面上 —— 旁边看着的人只觉得「它说改好了,可什么都没变」,录不录屏都一样。
光靠提示词让它「改哪页先翻到哪页」约束不住,由应用兜底:

- **跟随,常开,不在任何开关后面。** 经 MCP 的每一次写(`edit_text`、`edit_plan`、`edit_pages`、
  `replace_image`、`undo`、`redo`)落盘后,server 推 `edit.follow`:画布等新版本就绪,翻到那一页,
  把被改的那一处框出来,等两帧确认画上去了再答 `edit.followed`。server 在改稿子的串行队列里等它,
  所以并发来的改动一条一条上屏。人在界面上改的不跟 —— 画布本来就在他眼前。
- **改字不重载。** 只换了一段字时 server 推 `deck.patched`,画布就地换掉,不整份重载、不白一下;
  对不上(版本接不上、那段字认不准、元素里还有子元素)就照旧重载。

### 新功能:`studio.orca/ui-targets` v1

MCP 调用本身不带位置。录屏、教学类宿主要加光标、推近、目标框,得知道改动在屏幕上的哪儿 ——
这套约定补的就是这一块,和 ocut pro 共用。工具 `_meta` 里声明 `{"studio.orca/ui-targets": {"version": 1}}`。

- `resolve_ui_targets` 只读,`{targets: [...]}` 1–32 条,每条三选一:`{slide, text}`、
  `{slide, selector}`、`{controlId}`。控件有 `canvas`、`filmstrip.slide.<n>`、`history.undo`、
  `history.redo`、`control.capsule`、`gallery.recipe.<id>`,界面上靠 `data-ui-target` 认。
  画布元素只在那一页正显示时 visible;滚出页胶片的缩略图是 not_visible,露一半给露出的那一半。
  返回 `measuredAt`、`coordinateSpace: screen_points_top_left`、按顺序的
  `targets: [{query, status, window, targetId, rect?, reason?}]`。
- **写操作回执**:第一段人话不变,量到位置时第二段固定是 `{"uiTargets":[…]}`。数组由细到粗 ——
  先是被改的元素(`targetId` 形如 `canvas.slide.<n>.element:<选择器>`,原样当 controlId 能再查),
  再是整张画布;每一项带 `measuredAt`(Unix 毫秒)。数组里不另带 `coordinateSpace`:
  回执和操作记录里的 `rect` 一律是全局屏幕点、左上角为原点,等同 `screen_points_top_left`。
- **`recording_events`**:agent 的事件带同一份 `uiTargets`,事件时间就是上屏那一刻。
- 它和录制工具一样不经过控制权:不报活动、不锁画布,人接管着也能查。

旧的 `visual_target` 和各工具上的 `dev.jevbot/ui` 标注已删掉 —— 约定用提供方自己的名义,
不跟某一个宿主走。`control_state` 照旧,宿主读控制权用。

## 基础编辑

`edit_pages` 对应右侧「页」栏的添加空白页、删除、前移和后移。`index` / `to` 从 0 开始，移动目标是最终位置；添加可用 `index = slideCount` 追加。必须传 `deck_status` 的 `expected_revision`。同步现有 brief 页数、大纲及仍相邻的转场；新增页的大纲版式和理由留空，等 Agent 补充。嵌套 section、标签缺失和页序不同步的大纲会拒绝修改。

`replace_image` 对应选中图片后的路径输入框。传画布检视返回的 `slide`、简单 id/data-anchor 选择器、`old_source`、`expected_revision`；`source_path` 是稿子目录内已有图片的相对文件路径。保留尺寸、样式和转场属性。暂不导入外部资源，不支持 srcset、picture、延迟加载、base 地址或运行时生成的路径选择器。

`read_page` / `write_page` 按页读写源码:`read_page` 给某一页 `<section>` 在成品里的原文和同一次读盘的版本号,
`write_page` 拿新源码整页换掉那一页,页外一个字不动。新源码必须恰好是一个不嵌套的 `<section>`,
标签没闭合好、会吞掉别的页时拒绝。agent 只改一页时用它们,不用读写整份 HTML。

画布只换变了的那几页,不整份重载:server 把磁盘上的新版和画布上的那一版按页比对,页数一样、页外除了注释
一字未改时推 `deck.patched` 带上变了的页,画布交给稿子的 engine(`window.__orcaReplaceSlide`)换掉,
engine 只对那一页重做加载时的准备,再调 reveal 的 `Reveal.sync()` / `Reveal.syncSlide()`。
`write_page`、撤销/重做、删元素的改字、`replace_image`,以及 agent 用自己的工具直接改文件,都走这条路;
只改了 `.deck/` 里的元数据或转场计划注释时画面上什么都不动。增删页、改了页外的东西或素材、
稿子的 engine 太旧、页里有 `<script>` 时才整份重载。

三种操作与改字共用 `undo` / `redo` 和操作记录。结构及图片编辑要求 HTML 和关联元数据仍匹配才可撤销；有外部修改会拒绝。共享编辑按稿子串行执行，旧版本的并发请求会拒绝。写入先准备临时文件，再校验输入和替换；失败尝试还原已经写入且仍匹配的文件。这不是进程崩溃情况下的多文件原子事务。历史仍只在当前 server 进程内保存。
