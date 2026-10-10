# 同款

用户拿来一个参考（一段视频、一份别人的稿子、一句「像 XX 那样」），说「做个同款」时，读这里。

一个同款是一份**配方**：参考作品的内容结构 + 动效原则，整理成你照着就能复刻的形式。
它和版式模板不是一回事 —— 模板给的是填空坐标，配方给的是「这几页是什么关系、为什么这么接」，
坐标只给做转场锚的那几个元素（理由见 SKILL.md「示例怎么用」）。

不选同款、只给主题和内容框架的需求，不读这里，按 SKILL.md 的流程走通用规范。

## 现有同款

| id | 名字 | 适合 | 入口 |
| --- | --- | --- | --- |
| `recap-credits` | 电影级回顾片尾 | 结尾页：回顾整份稿子 + 感谢幕后成员 | [recap-credits/RECIPE.md](recap-credits/RECIPE.md) |
| `drink-showcase` | 四栏产品切换 | 四个平级产品逐个亮相，最后展开主推款 | [drink-showcase/RECIPE.md](drink-showcase/RECIPE.md) |
| `cobalt-grid` | 扫描线变柱状图 | 年报、季报：一组随时间变化的数，封面装饰直接长成图表 | [cobalt-grid/RECIPE.md](cobalt-grid/RECIPE.md) |
| `story-circle` | 一张照片接一张照片 | 故事稿：用几张照片讲演变，靠照片里前后呼应的形状接起来 | [story-circle/RECIPE.md](story-circle/RECIPE.md) |
| `neo-grid` | 网格面板重排 | 路演、发布会的数据段：几个并列的关键数字，其中一个最重要 | [neo-grid/RECIPE.md](neo-grid/RECIPE.md) |
| `editorial-tri-tone` | 原则墙钻进一张卡 | 几条平级的原则、价值观、要点，先成墙再逐条展开 | [editorial-tri-tone/RECIPE.md](editorial-tri-tone/RECIPE.md) |
| `emerald-editorial` | 序号块钻进章节 | 分章节的汇报：议程的序号块就是进入章节的门 | [emerald-editorial/RECIPE.md](emerald-editorial/RECIPE.md) |
| `soft-editorial` | 三色卡片收成图表 | 三条并列的洞察，最后收进一张对比图表 | [soft-editorial/RECIPE.md](soft-editorial/RECIPE.md) |
| `forest-timeline` | 一条线走完全稿 | 回顾和规划：时间线、占比、关键数字由同一条线串起来 | [forest-timeline/RECIPE.md](forest-timeline/RECIPE.md) |
| `spec-wall` | 实拍接进参数墙 | 产品介绍：从一段实拍视频接到参数一览 | [spec-wall/RECIPE.md](spec-wall/RECIPE.md) |
| `data-report` | 一张表做成汇报稿 | 用户给了表格：读数、做图、标出处，总览的一格展开成图表 | [data-report/RECIPE.md](data-report/RECIPE.md) |

## 怎么用一个同款

1. 读它的 `RECIPE.md`。先看「适用 / 不适用」，用户的内容撞上「不适用」就别硬套，告诉用户为什么，换通用流程。
2. 按「内容槽位」从用户给的材料里取值。缺的自己定，把假设写进转场计划的注释里，不要一上来问一串问题。
3. 照「页面结构」和「动效原则」写页面。样稿 `index.html` 是给你看手法和分寸的，不是让你改字。
4. 按 SKILL.md 流程第 6–8 步核版式、录制、看视频，再对一遍配方自己的「自检」。

## 写一个新同款

一个目录一个同款：`recipes/<id>/`，里面三样东西：

| 文件 | 内容 |
| --- | --- |
| `RECIPE.md` | 配方。开头 frontmatter 给机器读（应用的同款列表靠它），正文给 agent 读 |
| `index.html` | 能跑的样稿，用占位内容把整个配方演一遍，**至少 6 页**（首页点进去要能看完一份完整的稿子，不只是演完手法）。`examples/` 里已经有合适的稿子时不放这个，用 frontmatter 的 `sample` 指过去 |
| 样片、封面 | 不用自己放。OrcaPPT 按样稿内容自动录一份缓存在应用数据目录，样稿、引擎或 `preview` / `cover` 一改就重录。样片只录 `preview` 指定的几页 —— 首页悬停是让人一眼看到看点，不是把整份稿子放一遍 |

`RECIPE.md` 的 frontmatter：

```yaml
---
id: recap-credits          # 和目录名一致
title: 电影级回顾片尾       # 给人看的名字
mode: 汇报稿               # 汇报稿 / 故事稿
order: 1                   # 首页排第几,小的在前。可省略(排在写了的后面)
sample: ../../examples/x   # 样稿用 examples/ 里现成的那份（相对本目录，不能出 skill 目录）。可省略（用本目录的 index.html）
summary: 一句话，什么场合用  # 不是标签
preview: 4-5               # 样片只录这几页（页号从 1 数，含两头）：只放这个同款的看点。可省略（录整份）
cover: 4.9                 # 首页封面取样片第几秒，可省略（默认 75% 处）
---
```

正文按这几节写，顺序不变 —— agent 是按这个顺序干活的：

1. **参考拆解**：参考作品是怎么做到的，哪几样东西叠出来的。只写观察，不写评价。
2. **适用 / 不适用**：什么内容能套，什么内容套了会露馅。
3. **内容槽位**：用户要给什么、缺了怎么补。每个槽位写清默认值。
4. **页面结构**：几页、每页的主角、做转场锚的元素的标准位置。
5. **动效原则**：转场计划怎么写、时长和节奏的规则、**为什么**。
6. **硬规则**：撞上就错的东西。
7. **自检**：录完看什么。

**同款不许自带动画实现。** 参考里的效果引擎做不到时，先把能力加进 `runtime/`
（同时写进 `transitions.md` 或 `visual-spec.md` 的通用规范），配方里只引用它。
否则每个同款各带一份私有 JS，下一个同款想复用就得抄。
