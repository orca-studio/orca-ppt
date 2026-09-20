# orca-ppt

> 演示稿的眼睛和手。你的 agent 通过 MCP 连进来。

左边阶段栏和页胶片,中间**真在跑的那份 deck**(reveal.js + GSAP 在放,不是截图),
右边待办队列。

你在画布上点中一个标题、写一句「这儿太挤」,它带着页号、CSS 选择器、1920×1080 设计坐标和
一张裁切图挂进队列;跟你的 agent 说一声,它调 `take_requests` 取走 —— **拿到的是坐标,
不是形容词**。

**我们不驱动模型。** 你已经有 agent 了(Claude Code、Cursor、……),让它连进来,
比我们再造一个 agent 客户端强。

**状态:MCP 已接通。** 放映、检视锚、五阶段(定题 → 选主题 → 列页面 → 写转场 → 出稿)、
产物校验都在,agent 通过 MCP 驱动。还没有转场时间轴和录制。

```bash
# 应用开着的时候,MCP 就挂在这儿
claude mcp add --transport http orca-ppt http://127.0.0.1:6722/mcp
```

agent 能打开 deck、驱动画布跳页、取走你挂起的锚、拿阶段的做法、跑产物校验,
还能 **`capture_slide` 自己截一张图看效果** —— 稿子好不好只有放映能回答。

细节见 [MCP.md](./docs/MCP.md)。

```bash
# 开发时直接开一份稿子
ORCA_PPT_DECK=~/ghq/github.com/zhenwusw/orca-transition-skill/examples/forest-timeline pnpm dev
```

## 为什么

演示稿是一个**必须被放映才能评判的对象**,而 agent 工作流里没有放映这一步。转场对不对,
只有翻页的那 600 毫秒能回答;一页挤不挤,只有满屏 1920×1080 能回答。截图回答不了,文字
更回答不了。完整论述见 [VISION.md](./docs/VISION.md)。

## 开发

需要 Node 24 LTS 和 pnpm。

```bash
pnpm install
pnpm dev          # 起 server + 渲染层 + Electron 壳
pnpm typecheck
pnpm test
```

## 文档

| 文档                                   | 内容                                  |
| -------------------------------------- | ------------------------------------- |
| [Vision](./docs/VISION.md)             | 要解决什么,不做什么                   |
| [Architecture](./docs/ARCHITECTURE.md) | 系统形状与决策(含否掉了什么)          |
| [Deck Mode](./docs/DECK-MODE.md)       | 垂直闭环:阶段、产物契约、检视锚、自检 |
| [MCP](./docs/MCP.md)                   | 工具表、方向、怎么接进你的 agent      |
| [Roadmap](./docs/ROADMAP.md)           | 里程碑与验收                          |
| [AGENTS.md](./AGENTS.md)               | 在这个仓里干活的规矩                  |

## 内容层

规范、主题、版式、录制脚本不在本仓,从 skill 读:

- [orca-transition-skill](https://github.com/zhenwusw/orca-transition-skill) — 转场、主题、版式、`capture.mjs`
- [orca-motion-skill](https://github.com/zhenwusw/orca-motion-skill) — 场景内部的 MG 动画
- [ppt.orca-studio.ai](https://ppt.orca-studio.ai) — 示例库

skill 更新,产品跟着更新,不两边同步。

## 致谢

形状借自 [TasteCode](https://github.com/Leonxlnx/tastecode):本地 server 拥有状态、适配器
驱动官方 CLI、渲染层是薄客户端,以及「真正的差异化是上面那个垂直 Mode」这个判断。

## License

[MIT](LICENSE)
