# 画布检视与控制实施计划

目标：用户与 Agent 指向同一份稿子、同一页和同一个元素；Agent 修改后能够确认画布已经加载目标版本。
参考 [Remotion WebMCP](https://www.remotion.dev/docs/ai/webmcp) 和 [Studio 实现](https://github.com/remotion-dev/remotion/blob/main/packages/studio/src/components/WebMcp.tsx)。

## 阶段 1：当前画布检视（已实施）

- [x] `canvas.inspect`：现场页码、设计尺寸、播放状态、当前选区、当前内容版本与已加载版本。
- [x] `canvas.select`：用户和 Agent 共用选择/取消选择操作，持续高亮；页码或版本失效时拒绝。
- [x] 元素枚举：页内选择器、文字、几何、可见性和资源地址，上限 500 个。
- [x] 当前页运行时 HTML：排除应用界面与辅助覆盖层，上限 100000 字符。
- [x] 当前错误：加载、控制台脚本、资源与未处理 Promise 错误，上限 50 条。
- [x] 可选目标版本等待；截图附带实际页码、文档与已渲染版本，超时不视作成功。
- [x] MCP 工具、右栏「页」中的选择/取消选择入口，以及换页/重载时的选区失效。
- [x] guest、协议往返、预览响应和 MCP 映射测试；真实 Electron + MCP 修改/渲染/截图/撤销验收。

验收场景：用户在界面选择标题，Agent 读取相同选区及元素列表；选择器与页号/版本一起使用；修改文字后等待新版本，截图携带该版本；旧版本选择被拒绝；撤销后确认原版本。

## 阶段 2：转场证据（待实施）

- [ ] 公开转场元数据：from/to、承接元素、时长和手法。
- [ ] 复用离屏 `__capture.go/seek`，按转场时间生成开始/中间/结束证据图。
- [ ] 返回转场 ID、版本、实际时间和截图，保证不驱动用户当前画布。
- [ ] 验收 GSAP 转场、match-cut 和不支持 capture 的旧稿子。

## 阶段 3：可见画布播放控制（待实施）

- [ ] 验证观看模式中的暂停、seek、恢复，与离屏 capture 模式的差异。
- [ ] 增加共享播放状态、转场暂停和定位协议，界面与 MCP 同步接入。
- [ ] 验证键盘、自动播放、Agent 操作和用户接管的状态同步。

## 阶段 4：辅助线与确定性布局检查（待实施）

- [ ] 设计坐标辅助线、安全区与可见覆盖层。
- [ ] 元素越界、文本溢出及资源失败检查，结果绑定元素锚。
- [ ] 检查规则归 `deck-agent` / skill，server 只负责运行与传输。

## 阶段 5：WebMCP 入口（待验证）

- [ ] 验证所用 Electron 的 WebMCP API 支持，以及外部 Agent 对窗口工具的发现/调用路径。
- [ ] 如可用，仅增加共享协议的薄适配层，不复制状态和操作实现。

## 已实施接口与边界

MCP 工具：`get_canvas_context`、`get_canvas_elements`、`get_canvas_html`、`get_canvas_errors`、`select_canvas_element`。
四个读取工具接受可选 `expected_revision`；选择工具必须传 `selector`（null 表示取消）、零基页号 `slide` 和 `expected_revision`。
`capture_slide` 也接受可选 `expected_revision`。

`revision` 是 server 当前内容哈希；`renderedRevision` 来自入口 HTML 响应的 Server-Timing 信息。入口响应前后检查内容版本一致，再标注版本；HTML 字节和相对资源路径不改写。guest 读取导航 performance 条目中的版本，不通过重新 fetch 当前源码来冒充已加载版本。
`current` 仅在画布 ready 且已加载版本与当前版本相符时成立。需要严格版本检查时传 `expected_revision`；等待画布最多 10 秒，字体等待另有 3 秒上限。两次绘制帧后重新读取证据，server 再检查版本与文档是否变化。

选区是临时渲染状态，由当前 guest 测量，server 通过现有 Roundtrip 调度。节点删除、翻页或重载即失效。选择器优先 id/data-anchor，退回页内路径；不保证跨版本稳定。几何是页面设计坐标中的轴对齐包围框，以 `.slides` 为原点，避免 Reveal 垂直居中导致偏移。UI 提交意见仍走原有队列；读取现场不清空意见。

错误监听覆盖 guest 注入后的事件，以及 Stage 捕获的加载和控制台错误；空列表不表示整个应用无错误。没有实现 source map 符号化或元素到源码行列的精确映射。DOM 不包含 Canvas/WebGL 像素，仍需截图验证视觉效果。

版本确认表示目标稿子已加载，不能证明所有媒体解码完成或转场达到稳定态；`capture_slide` 指定页时仍沿用现有转场等待。外部依赖不在 deck 内容哈希范围内。跨资源加载期间并发修改不提供不可变快照保证；这些留给阶段 2 的离屏证据机制处理。

## 验证记录

2026-10-03：真实 Electron 临时两页稿子（Reveal.js），通过 MCP 验证工具发现、读取 UI 选区、设计坐标、DOM 排除覆盖层、空错误列表、Agent 选择、带版本 PNG、旧版本拒绝、改字后新版本等待与撤销还原。临时稿子原始 revision `5f26e1f484e21935`，改字后 `5b0d40f230283b74`，撤销恢复原版本。没有修改用户稿子。

检查结果：`pnpm typecheck`、`pnpm test`（41 个测试文件、490 项测试）、`pnpm lint` 全部通过；生产构建通过。另在界面实测选择高亮与翻页后选区失效。

原有主题/布局测试在 Node 26 下受到可选 Web Storage 全局的影响；测试改用隔离的内存 Storage，产品存储行为没有改变。
