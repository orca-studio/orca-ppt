# 可以从 taste-skill 借的东西(已记录,未排期)

2026-10-28 记。来源是另一个会话读 [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)
(本地 `~/ghq/github.com/Leonxlnx/taste-skill/skills/taste-skill`)后给的对照。只是记录,不要求实现;
里面对 orca-ppt 现状的描述是那个会话读代码得出的,动手前要再核对一遍。

taste-skill 是一个「反 AI 味」的网页设计 skill,流程是:读 brief → 写论点 → 脚本抽方向 → 想法句 → 文案 →
构建 → 浏览器检查 → 看截图打分 → 动效 → 报告。

## orca-ppt 已经比它好的(不用改)

- 分阶段做,每个阶段出一份文件就停(`packages/deck-agent` 的 prompts.ts)。
- 先有内容再挑版式;按内容挑页面类型的那张表里有「严禁用」一列。
- check-deck 等入场动画放完再量:能事后核对的规则,就不必事前把版式定死。
- 不许写自己的 style、不许写死色值,视觉套路在结构上就写不出来。

## 可以借的(按性价比排)

1. **主题和配色抽 3 选 1。** 主题阶段现在是「先看有没有合适的」,模型容易总挑那两三个。
   做法:按 brief 的 tone / mode 过滤,抽 3 组「主题 + 配色」;模型选一组并写理由,抽签种子记进
   theme.json。只抽主题和配色,不抽版式。抽签逻辑放 deck-agent,数据放 `runtime/`。参考 taste 的
   `scripts/draw.mjs --options 3`。
2. **论点层。** 汇报稿的 brief 没有全稿论点(只有故事稿有);outline 里每页只有 subject,没有 claim。
   做法:
   - brief 加 thesis,每页加 claim,「标题就是这一页的结论」;validateOutline 查有没有写。
   - 竞品测试:把名字换成竞品,这页的结论还成立的话,就是套话。
3. **静帧评分表。** transitions.md 的自检标准全是查转场,停稳之后那一帧有没有审美问题,没人评。
   做法:参考 taste 的 `references/critique.md` 做一份 PPT 版。
   - 评什么:每页看 5 秒能不能说出结论;眯起眼看是不是只剩一个主角;跨页左边缘有没有对齐。
   - 怎么评:打分,设封顶条件;只看图,不看代码。
   - 修多少:每轮修前三个问题,最多三轮。
     评静帧不用录制,`capture_slide` 现成就有。可以当作 ROADMAP 里 M5 那个问题的回答。
4. **交付报告的硬要求。** 没做完不许报告。报告必须列出:
   - 要替换的示例内容和数据;
   - 图片出处;
   - 还有哪里不够好;
   - 哪些检查没跑。
     `brief.assumptions` 和 `data.md` 已经打了底子。
5. **文案套话检查。** 视觉套路已经被结构挡住了,最容易露 AI 味的是文字。
   - 套话:「赋能 / 助力 / 打造 / 一站式 / 全方位」、emoji、没有出处的百分比。在 check-deck 里加文字规则。
   - 数字:稿子里的每个数,要么能追到 `data/`,要么标成示例。
     参考 taste 的 `scripts/lint.mjs`。
6. **故事稿的找图工具。** `story-mode.md` 没说照片从哪来。taste 的 `scripts/assets.mjs` 能从 Openverse、
   Wikimedia、大都会博物馆、芝加哥美术馆搜允许商用的图,下载时记下授权,生成署名列表;署名可以放在结尾页。
7. **评测集(以上几条的基础)。** taste 的 `evals/evals.json` 是把同一个 brief 分别交给装了和没装 skill 的
   agent,然后盲评。orca 有单测,但没有成品质量评测。做法:
   - 建 6–8 个固定 brief;
   - 记录 check-deck 的 ✗ 数、capture 的提醒数;
   - 对关键帧盲评。

## 不该借的

- taste 的审美禁令:orca 的毛玻璃、立体柱、文字镂空是功能。
- 动的元素数量下限:和「先写两页的关系,再选手法」冲突。
- 多宽度响应式检查:画布固定 1920×1080。
- 一口气跑完的长流程:orca 是分阶段、每阶段停下来。

## 真要做时

建议先做 1、2、4,改动集中在 prompts.ts、validateOutline、SKILL.md;3 和 6 等评测集建起来再做。
改动位置守 AGENTS.md 的边界:规范放 `skills/orca-ppt/`,确定性检查放 deck-agent 或 check-deck,
server 不碰。
