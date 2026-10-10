# 在这个仓里干活

先读 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) 和
[docs/DECK-MODE.md](./docs/DECK-MODE.md)。改任何跨包的东西之前,先读那两份里对应的边界。

## 不许越过的边界

1. **渲染层不 spawn 进程、不碰文件系统、不读凭证。** 需要这些就加一个协议方法。
2. **server 不产生品味。** 创作规则、版式判断、自检标准都在 `packages/deck-agent`,不许在
   server 编排或 MCP 表面里复制一份。
3. **界面能做的每一件事都是一个协议方法。** MCP 是这个协议的第二个薄客户端;界面里有、
   协议里没有的操作,不许存在 —— 哪怕它「只是本地的」,比如跳到第几页。
4. **规范内容只在 `skills/orca-ppt/` 里。** 转场规范、主题、版式、同款配方都在这里,server、
   deck-agent、渲染层只读它,不复制一份(见 DECK-MODE 末节)。改规范就改 `skills/orca-ppt/`。

## 协议

`packages/contracts` 是唯一真相。两个方向、每个载荷都在边界上校验。改协议 = 改契约包,
server 和渲染层各自跟着 typecheck 报错,这是有意的。

## deck 是磁盘上的目录

不是数据库里的 blob。用户随时能把目录拿走继续用别的工具干。任何让 deck 只能在本产品里打开
的设计,直接否掉。

## 提交前

```bash
pnpm typecheck && pnpm test && pnpm lint
```
