# 开发者文档

给想从源码运行、改代码或把 Orca PPT 接进自己 agent 的人。产品介绍见仓库根目录的 [README](../README.md)。

## 它是什么(技术上)

一个演示稿工作台:Electron 壳 + 本地 server + 渲染层。中间的画布是**真在跑的那份 deck**
(reveal.js + GSAP 在放,不是截图)。MCP 把工作台的操作接口开放给 agent,让 agent 代你执行。

你在画布上点中一个元素、写一句「这儿太挤」,它带着页号、CSS 选择器、1920×1080 设计坐标和
一张裁切图交给 agent —— **agent 拿到的是坐标,不是形容词**。

**我们不驱动模型。** 你已经有 agent 了(Claude Code、Cursor、……),让它连进来,比我们再造
一个 agent 客户端强。

## 从源码运行

需要 Node 24 LTS 和 pnpm。

```bash
pnpm install
(cd skills/orca-ppt && npm ci) # skill 的运行时依赖(reveal.js、GSAP),稿子按相对路径引它们
pnpm dev                       # 起 server + 渲染层 + Electron 壳
pnpm typecheck
pnpm test
pnpm lint
```

开发时直接开一份稿子:

```bash
ORCA_PPT_DECK=$PWD/skills/orca-ppt/examples/forest-timeline pnpm dev
```

打包当前平台的应用:`pnpm package`,产物在 `release/`。

## 接进你的 agent(MCP)

应用开着的时候,MCP 就挂在本机:

```bash
claude mcp add --transport http orca-ppt http://127.0.0.1:6722/mcp
```

agent 能打开稿子、驱动画布跳页、取走你指出的位置、读同款配方和规范、跑产物校验,
还能 `capture_slide` 自己截一张图看效果。工具表和约定见 [MCP.md](./MCP.md)。

## 内容层:skill

规范、主题、版式、同款配方、录制脚本都在 [`skills/orca-ppt/`](../skills/orca-ppt)
(原 `orca-ppt-skill` 仓,2026-10-10 带着历史并进来)。agent 通过 MCP 的 `read_skill` 读它,
不需要单独安装。发布版的 skill 跟着 app 一起发,版本和 app 一致,见
[ARCHITECTURE.md](./ARCHITECTURE.md)「交付形态」。

不装应用、只想让 agent 用这套规范的话,按 skill 的惯例把目录链进 agent 的 skills 目录:

```bash
ln -s "$PWD/skills/orca-ppt" ~/.claude/skills/orca-ppt
(cd skills/orca-ppt && npm ci)
```

相关:

- [orca-motion-skill](https://github.com/zhenwusw/orca-motion-skill) — 场景内部的 MG 动画。
  可选件,app 不读它;稿子页面自己加载它时,skill 的 engine 在转场后播放场景
- [ppt.orca-studio.ai](https://ppt.orca-studio.ai) — 示例库

## 文档索引

| 文档                              | 内容                                  |
| --------------------------------- | ------------------------------------- |
| [Vision](./VISION.md)             | 要解决什么,不做什么                   |
| [Architecture](./ARCHITECTURE.md) | 系统形状与决策(含否掉了什么)          |
| [Deck Mode](./DECK-MODE.md)       | 垂直闭环:阶段、产物契约、检视锚、自检 |
| [MCP](./MCP.md)                   | 工具表、方向、怎么接进你的 agent      |
| [Roadmap](./ROADMAP.md)           | 里程碑与验收                          |
| [AGENTS.md](../AGENTS.md)         | 在这个仓里干活的规矩                  |
| [品牌素材](./brand/README.md)     | Logo、头像、宣传图和文案口径          |

## 为什么要有放映

演示稿是一个**必须被放映才能评判的对象**,而 agent 工作流里没有放映这一步。转场对不对,
只有翻页的那 600 毫秒能回答;一页挤不挤,只有满屏 1920×1080 能回答。截图回答不了,文字
更回答不了。完整论述见 [VISION.md](./VISION.md)。

## 致谢

形状借自 [TasteCode](https://github.com/Leonxlnx/tastecode):本地 server 拥有状态、适配器
驱动官方 CLI、渲染层是薄客户端,以及「真正的差异化是上面那个垂直 Mode」这个判断。
