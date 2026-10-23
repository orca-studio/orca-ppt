# 迁移方案:skill 并进产品仓

2026-10-10 定的:orca-ppt 和 orca-ppt-skill 不再分两个仓管理,skill 做成产品内置。

**已执行(2026-10-10)。** skill 带历史并进 `skill/`(`git subtree add`,合并提交以老仓 `main`
为父);第 4 节的边界和文档已改;整个仓库在原 `zhenwusw/orca-ppt-skill` 上开源(保留它的 star、
fork),转到 `orca-studio/orca-ppt`,GitHub 的转移和改名会把旧地址自动跳过来 —— 这就是旧仓的
「重定向」,不再另做墓碑归档。还没做的:本机旧路径的软链(第 5 节)、`deck.relink`、展示站的去留。
随后按 skill 仓库的惯例把 `skill/` 挪到了 `skills/orca-ppt/`(下文的 `skill/` 都指它)。
下面保留执行前的方案,备查。

## 1. 为什么

产品往后只做两件事(见 VISION 待更新):

- **做同款**:首页是同款画廊,每个同款是 skill 里 `recipes/<id>/` 的一份配方,卡片右上角复制
  「做同款」提示词给 agent,点卡片放映样稿。
- **通用原则**:配色、内容组织、逐页动效的规范,内化在 skill 里,agent 侧通过 `read_skill` 用,
  不在界面上做成选择。

两件事都是「界面 + skill 内容」一起改的:同款画廊这一轮就同时动了 contracts、server、web
和 skill 的 `recipes/`、`runtime/`、`references/`,两边的提交只能靠人脑对齐。发布版早就是
绑在一起的(`Resources/skill` 跟 app 同版本,见 ARCHITECTURE「交付形态」),分仓只剩下
成本:`tools/skill-lock.json` 要手动推提交号,改一处规范要跨两个仓提 PR。

不变的是**内容只有一份**:规范、主题、配方仍然只写在 skill 目录里,server、deck-agent、web
不复制。变的只是这个目录住在哪。

## 2. 现状

| 环节           | 现在怎么做                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源码           | `~/ghq/github.com/zhenwusw/orca-ppt-skill`,独立仓,41 个提交                                                                                                          |
| 开发时找 skill | `apps/server/src/skill.ts` 的 `DEFAULT_LOCATIONS`,第一条就是上面那个 ghq 路径;`ORCA_PPT_SKILL` 可覆盖                                                                |
| 打包           | `tools/package.mjs`:按 `tools/skill-lock.json` 锁定的提交 `git archive`,`npm ci --omit=dev`,放进 `Resources/skill`,写 `bundle-manifest.json`                         |
| agent 读规范   | MCP `list_skill` / `read_skill`(走 `skill.list` / `skill.read`),不要求宿主装 skill                                                                                   |
| 单独用 skill   | README 里写着 `npx skills add zhenwusw/orca-ppt-skill`;skill 仓还有一个 `site/`(wrangler 部署的展示页)                                                               |
| 稿子引用 skill | 稿子里写**相对路径**到 skill 根:`{{ROOT}}/node_modules/reveal.js/...`、`{{ROOT}}/runtime/engine.js`。`instantiate` 建稿时按 deck 和 skill 的实际位置算出这个相对前缀 |

最后一行是迁移里唯一真正会坏东西的地方,见第 5 节。

## 3. 目标形态

```
orca-ppt/
  apps/ packages/ docs/ tools/
  skill/                 ← 原 orca-ppt-skill 仓的全部内容,带历史
    SKILL.md references/ runtime/ recipes/ templates/ scripts/ examples/
    package.json         ← 仍然自己 npm 管,不进 pnpm workspace(理由见下)
```

- **目录叫 `skill/`,放在仓根**,不放 `packages/`:它不是一个 TS 包,也不被 import;
  它是一个能被整个拷走、单独给 agent 用的目录。放在 `packages/` 下会诱导人把它当库来引。
- **不进 pnpm workspace。** 稿子按相对路径引 `skill/node_modules/reveal.js/dist/...`,
  预览服务对软链做了越界检查(`preview-host.ts`,先 realpath 再比 allow root)。pnpm 的
  node_modules 是指向仓根 `.pnpm` 仓库的软链,realpath 之后落在 `skill/` 外面,全部 403。
  继续用 skill 自己的 `package-lock.json` + `npm ci`,和现在打包时一样。
  (以后可以把 reveal / gsap 的 dist 拷进 `skill/runtime/vendor/`,连 `npm ci` 都省掉,
  那是另一件事,不跟迁移绑。)
- **不再单独分发 skill**(第 7 节已定):`skill/` 拷出去大概率还能用,但不是承诺。
  agent 一律通过 MCP `read_skill` 读同一版本的规范。

## 4. 要先改的边界和文档

这些写的是旧决定,不先改,迁移就是违反仓库规则:

| 位置                                             | 现在写的                                                       | 改成                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `AGENTS.md` 边界 4                               | 规范内容不进本仓。转场规范、主题、版式从 skill 目录读          | 规范内容只在 `skill/` 里。server、deck-agent、web 只读它,不复制;改规范就改 `skill/`   |
| `docs/DECK-MODE.md` 末节「与 skill 的关系」      | `orca-ppt-skill` 不被抄进本仓,作为内容层依赖被读取             | 同上,指向 `skill/`;「否掉:把规范复制进 deck-agent」保留 —— 那条的理由(两份会分叉)没变 |
| `docs/ARCHITECTURE.md`「交付形态」               | skill 仓仍是规范内容的唯一来源,打包时复制进安装包,不进本仓源码 | `skill/` 是唯一来源;打包从同一个提交取;删掉 skill-lock 那段。变更表加一行             |
| `README.md`、`docs/VISION.md`                    | 链接到 zhenwusw/orca-ppt-skill                                 | 改成 `skill/`;VISION 的定位按「做同款 + 通用原则」重写                                |
| `skill/README.md`、`skill/references/install.md` | 独立仓的安装方式                                               | 说明它是 orca-ppt 的一部分;单独用的方式见第 7 节的决定                                |

## 5. 已有的稿子

稿子里引 skill 用的是**相对路径**。skill 从 `~/ghq/github.com/zhenwusw/orca-ppt-skill`
挪到 `~/ghq/github.com/orca-studio/orca-ppt/skill`,所有按旧位置算过前缀的稿子都会白屏
—— 入口页照样 200,只有资源全 404(ARCHITECTURE 里记过同一种坑)。

处理分两步:

1. **过渡期**:旧路径留一个软链 `~/ghq/github.com/zhenwusw/orca-ppt-skill → …/orca-ppt/skill`。
   旧稿子不用改就能开。注意相对路径是按**软链所在位置**解析的,所以软链要放在原位置,不是
   把稿子里的路径改成软链。
2. **长期**:加一个协议方法 `deck.relink`(界面能做 = 协议方法,MCP 跟着有一个工具),
   把稿子里指向 skill 的相对前缀按新位置重算,复用 `instantiate` 里那段 realpath + 重写逻辑。
   打开稿子时发现引用的 skill 资源 404,界面提示一键修。

发布版不受影响:发布版的稿子本来就指向 `Resources/skill`,每次升级 app 路径都在变 ——
这其实是现有的问题(稿子跟 app 安装位置绑死),迁移顺便暴露出来,`deck.relink` 一起解决。

## 6. 步骤

每一步完了都跑 `pnpm typecheck && pnpm test && pnpm lint`,以及 skill 侧的
`node skill/scripts/check-deck.mjs` 和一次 `capture.mjs`。

1. **收尾 skill 仓**:把 skill 仓里没提交的改动(回顾片尾的 engine / tokens / 规范 / `recipes/`、
   `references/install.md`)先在 skill 仓提交,`tools/skill-lock.json` 推到这个提交,打一次包验证。
   这样迁移前后有一个两边都能复现的点。
2. **带历史并入**:`git subtree add --prefix=skill <skill 仓> main`(不 squash,保留 41 个提交,
   `git log -- skill/` 能追到每条规范的来历)。
3. **改找 skill 的路**:
   - `skill.ts` 的 `DEFAULT_LOCATIONS` 第一条换成仓内 `skill/`(按 server 源码位置往上找,
     不写死 ghq 路径);旧 ghq 路径留作第二条,过渡期后删。
   - `tools/package.mjs` 改成 `git archive HEAD:skill`(仍然只取提交过的内容,忽略工作区改动,
     这条原有的保证不能丢),删 `tools/skill-lock.json`,`bundle-manifest.json` 记 app 的提交。
   - `.gitignore` 合并 skill 的规则(`skill/node_modules`、`skill/examples/*` 那一串、
     `skill/recipes/*/index.mp4`)。
4. **改文档**:第 4 节那张表。
5. **旧稿子过渡**:旧路径放软链;排期做 `deck.relink`。
6. **测试接进来**:根 `pnpm test` 里加一项,对 `skill/recipes/*/index.html` 和
   `skill/examples/` 里进仓的示例跑 `check-deck.mjs`。录制慢、要系统 Chrome,不进默认测试,
   单列 `pnpm skill:capture`。
7. **旧仓归档**:README 第一行指向新位置,GitHub 上 archive。`npx skills add zhenwusw/orca-ppt-skill`
   的去留看第 7 节。

## 7. 要你定的

1. ~~单独分发 skill 还要不要?~~ **已定(2026-10-10):不要。** skill 只随 app 走,agent 通过
   MCP `read_skill` 读。连带的:
   - ARCHITECTURE「交付形态」里「首次引导时把 `Resources/skill` 链进 `~/.claude/skills` /
     `~/.agents/skills`」那段设计作废,改文档时一起删;
   - 旧仓 archive 后不再维护 `npx skills add zhenwusw/orca-ppt-skill`,README 里那行删掉;
   - 第 3 节「单独用 skill 仍然成立」降级为不保证:`skill/` 拷出去大概率还能用,但不再是承诺。

2. **skill 仓的 `site/` 展示页**:跟着搬进来、还是不要了?它和产品首页(同款画廊)的作用
   越来越重叠。
3. ~~同款样片进不进仓~~ **已定:不录样片**。0.1.12 以前首页悬停播样片,应用第一次打开时现录一份缓存;之后改成同款自带封面图(`poster.jpg`,`scripts/render-poster.mjs` 截),跟着 skill 进仓,应用和官网都不再录。

## 8. 不做的

- **不把 skill 改成 TS 包、不让 deck-agent import 它。** 规范是给 agent 读的文本,不是代码依赖。
- **不在迁移里顺手重排 skill 的目录结构。** 路径一变,所有 `read_skill` 的相对路径、提示词、
  稿子引用都要跟着变。迁移只换「住在哪」,结构改动另起。
