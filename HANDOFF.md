# Handoff

2026-09-20。上一轮只改决策文档,没动代码 —— `apps/` 下的未提交改动不是这一轮产生的。

## 这一轮定下来的两件事

### 1. MCP 转向的边界写清楚了:交出去的只有「执行」

之前文档里这件事是散的,现在 `ARCHITECTURE.md`「MCP 表面」和 `VISION.md` 都写死了:

|                                     | 归谁                                               |
| ----------------------------------- | -------------------------------------------------- |
| 编排(阶段状态机、闸门)              | **本地 server**。`phase_prompt` 上游不合规直接拒绝 |
| 状态(deck 目录、事件日志、待办队列) | **本地 server**。MCP 不持有状态                    |
| 执行                                | 交给 agent 宿主                                    |
| 授权                                | 交给 agent 宿主,不造第二套                         |

**判断依据**(以后再遇到「要不要自己做 agent 入口」按这个判):我们的用户已经坐在 agent
里了,宿主现成的;TasteCode 必须自己驱动模型,是因为它自己就是宿主,没有别人的授权系统
可以交还。另外我们的写入作用域只有用户打开的那一份 deck 目录,授权面比通用 coding agent
小一个量级。

新增的「否掉」项,别再重新提:

- **适配器层**(驱动各家 SDK、管会话、造授权 UI)—— 那是在做通用 agent 客户端,VISION 的
  非目标,而且每加一家引擎就再写一个。
- **自建一条直连模型的打分通道**,哪怕只用来给关键帧打分。理由不是做不了,是**人比它准
  且比它快**。

### 2. M5 自检回路:critique 归人,产出的是锚不是报告

目标不是全自动。演示稿哪里不对人一眼能判,产品要做的是**让不合格的地方被看见、并且一点
就能变成指令**。

三项确定性检查(页面自报问题、帧差量、匹配剪辑轮廓比对)全在 server,不用模型。关键设计
在 `DECK-MODE.md`「不合格产出的是锚,不是报告」:

- 每条不合格产出的就是一条**锚**,和人在画布上点出来的同一个结构(转场锚用
  `{ from, to, technique }`),note 自动填,附证据帧
- 时间轴/页胶片标黄,**点一下直接挂进待办队列**;agent 那头 `take_requests` 收到的格式和
  人点出来的完全一样,不用加新工具
- 反向约束:如果标黄只是个颜色、人看见之后还得回画布重新取一次锚,这轮自检等于白做

不做:自动视觉自评、自动修复轮次。agent 要看画面自己调 `capture_slide`(它回合内的事);
录制是几分钟的异步 job,跑完时发起它的那个回合多半已经结束,没有谁在那头等着被推送。

唯一残留的异步通知需求是「录制 job 完成给个不打扰的提示」,纯 UI,不碰 MCP。

## 改了哪些文件

`docs/ARCHITECTURE.md`(形状图、MCP 表面边界与否掉项、Deck Mode 责任表、变更表补 4 行)·
`docs/VISION.md`(产品段、赌注 4、和 TasteCode 的关系)· `docs/DECK-MODE.md`(自检回路重写、
检视锚去掉 thread 说法)· `docs/ROADMAP.md`(M5)· `README.md`(死链 `docs/PROVIDERS.md` →
`docs/MCP.md`)· `AGENTS.md`(边界 2 的「适配器」→「MCP 表面」)。

M2/M3 里关于适配器和 `canUseTool` 的记述保留原样 —— 那是已发生的里程碑,是历史不是现状。

## 待办:文档还没对上代码的地方

MCP 的传输方式已经从「单独进程 + stdio + 端口文件」变成「server 自己的 `/mcp`,Streamable
HTTP,同进程同端口 6722」(`apps/server/src/mcp-http.ts`,`apps/mcp` 已经不存在)。
`ARCHITECTURE.md` 和 `ROADMAP.md` 已对齐,**下面两处还是旧的**,没动是因为它们是安装说明、
怕和正在进行的改动撞车:

1. `docs/MCP.md`「装」一节 —— 还写着 `~/.orca-pptcode/port` 端口文件和
   `command: node args: [<仓库>/apps/mcp/dist/main.js]`。按代码里的注释应该是
   `claude mcp add --transport http orca-pptcode http://127.0.0.1:6722/mcp`。
2. `README.md` 顶部那段 `mcpServers` 的 jsonc —— 同上。

另外 `docs/MCP.md` 的工具表列了 8 + 2 = 10 个,ROADMAP 已改成 11 个,对一下。

## 下手前先读

`AGENTS.md` 的四条边界 · `docs/ARCHITECTURE.md`「MCP 表面」和变更表 ·
`docs/DECK-MODE.md`「自检回路」。改决策要改 `ARCHITECTURE.md` 并在变更表加一行,这是那份
文档自己立的规矩。
