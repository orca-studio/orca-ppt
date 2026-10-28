# PPTX 保真模式与导出器演进

**状态:已提议,未排期。** 2026-10-28 登记,不动代码。完整调研(7 页):
`/Users/zhen/projects/pdf/pptd-research.pdf`(本机,不在仓里)。

## 背景

对比了 DSH Desktop / Kimi 的 PPTD(YAML 声明式 → 原生 DrawingML)、ppt-master
(SVG → DrawingML,MIT)和 Orca 现在的 HTML 测量导出。结论:

- Orca 现有的转场和页内动画都只有浏览器能播。PowerPoint 播放器不能裁剪、不能加遮罩,
  没有相机,Morph 只能整页统一设(见 skill `references/transitions.md`「导出 PPTX」回退表)。
  直接写 OOXML 也补不上。
- 放掉一部分动效后,难的是静态可编辑性:文字重排、flex/grid 变成绝对坐标、段落/列表/图表
  的语义丢失。格式本身不是难点。
- 不让 agent 直接写 OOXML 当源:内容冗长,容易写坏,也难局部修改;HTML 和 PPTX 两份源还会漂移。
  导出器(`skills/orca-ppt/scripts/lib/pptx-write.mjs`)写 OOXML 是导出实现,不是源。
- 不兼容 PPTD,不复用 Kimi 的 WASM 或 DSH 的 JS 运行时(来源和授权存疑)。ppt-master 的
  思路可以借(MIT)。

## 现状基线(2026-10-28)

23 个同款里有 16 个带样稿(另 7 个只有 RECIPE.md 和封面图),用 `export-pptx.mjs --json` 各导一份,
`check-pptx.mjs` 全部通过。16 份共 109 页、93 次翻页。

**翻页**(按「导出 PPTX」回退表):

| 档   | 次数    | 说明                                                            |
| ---- | ------- | --------------------------------------------------------------- |
| 保真 | 68(73%) | 67 次平滑 + 1 次硬切                                            |
| 近似 | 11      | 5 次平滑、3 次擦除、3 次一变多 / 多合一(靠 PowerPoint 自动配对) |
| 降级 | 13      | 文字级匹配、逐位滚轮变成旧字淡出新字淡入;元素交接变淡入淡出     |
| 丢失 | 1       | 回顾片尾                                                        |

另外 57 页「新内容等主角到位才出现」的节奏丢了(和翻页同时出现),24 页的页内动画直接是放完的样子,
1 段视频变静帧。

**页面上的东西**:共 1650 个对象,文本框 935、原生形状 208、图片 507(31%)。

- 图片里一半(260 张)记的原因是**渐变或背景图**(有的叠着 clip-path、mask、filter);151 张是本来就是
  图片的 `<img>`;其余是 SVG 39、mask 14、渐变字 14、filter 11、伪元素 13、单边描边 2、iframe 1。
  glass-bars 一份就有 171 张图片、0 个原生形状。
- 但那 260 张里**平滑渐变不多**:glass-bars 的棱柱 120 张是 7 层硬边渐变拼出来的假 3D,swirl-rings、
  ring-timeline 的圆环 48 张是硬边径向 / 锥形渐变配遮罩,cobalt-grid、neo-grid 的网格和棋盘是平铺的
  图案,还有 44 张是 `url()` 背景图。一层平滑渐变只有约 43 张,加渐变字 14 张。
- **文字能改,但不会重排。** 一个 HTML 文字元素导成一个文本框,可是浏览器里折的每一行都成了一个
  `<a:p>`,还关了自动换行(`wrap="none"`)。在 PowerPoint 里改一个字,后面的行不会跟着走。
- 原生的项目符号、图表、表格、渐变、阴影:**一个都没有**。

结论:转场大部分保得住,难点在静态可编辑性,和「背景」一节的判断一致。

## 进展

分支 `pptx-compatible`。每一步都对 16 份同款重新导出,跑 `check-pptx.mjs` 和 OpenXmlValidator,
改到的同款在 PowerPoint for Mac 里存成 PDF,和网页逐页对着看。

1. **渐变转原生(2026-10-28)。** 图片 507 → 449。
   - 一层线性渐变(任意角度、朝角落、硬边、半透明)→ `a:gradFill` + `a:lin`。
   - 径向渐变:正圆里的用 `path="circle"`(PowerPoint 的圆形路径 100% 落在外框四角,等于 CSS 的
     `farthest-corner`,`closest-side` 按 1/√2 缩);椭圆形状里的 `closest-side` 用 `path="shape"`。
     长方形里的椭圆渐变 PowerPoint 画不出来(圆形路径不随长宽比拉伸),照旧截图。
   - PowerPoint 在色标之间不按 sRGB 插值,中段偏亮;写包时每段补 7 个按 sRGB 算的中间色标。
     全透明色标的颜色取相邻的,不然边上晕一圈灰。
   - 渐变字 → 字的 `rPr` 里写 `gradFill`,还能改字。PowerPoint 的字渐变铺在字上、不是整个框上,
     `.t-gradient` 本来就要求写在紧包着字的 span 上,对得上。
   - 顺带修了一个形状问题:`border-radius: 50%` 的长方形原来导成两头圆的胶囊,现在是椭圆。
   - 剩下的渐变图片大头是 glass-bars 的棱柱和圆环,要按同款拆成原生形状,不是通用转换能做的。

下一步:段落按原文分段、交给 PowerPoint 折行;导出时把元素身份写进形状名。

## 方案

HTML 仍是唯一的权威源,在它上面加四件事:

1. **PPTX 保真模式。** 用户一开始就说要交 PPTX 时,skill 只允许回退表里「保真」档的手法和
   能原生化的样式,由 lint 强制(现在只排优先级)。相当于在 HTML 里做 PPTD 那样的封闭词汇表。
   默认模式不变:动效全开,导出时报告降级。
2. **结构语义标注。** 借 ppt-master 的思路,用 `data-*` 标出段落、列表和原生图表。图表带
   可见回退和 JSON 数据,并校验两者同步。导出器按语义生成原生对象,不再靠测量 DOM 去猜。
3. **导出器补原生输出。** 线性/径向渐变(`a:gradFill`)、渐变文字(`rPr` 里的 `gradFill`)、
   阴影/发光、图片形状裁切,少截图;一个段落对应一个文本框;列表用原生项目符号。
4. **导出前查溢出。** 按 PowerPoint 的字体度量估文本高度,诊断定位到页和元素
   (参考 DSH 的 `pptd_check` / text-overflow)。

## OOXML 结构验证

导出的检查链改成:

1. 生成;
2. OOXML 验证(Open XML SDK 的 `OpenXmlValidator`);
3. 自定义检查:动画指向的对象在不在、元素越界、资源缺失、文字溢出;
4. PowerPoint 实测。

验证器不用打开 PowerPoint,就能查出结构、节点顺序和属性值的错误。报错带部件路径和 XPath,
能直接定位修复。

它只管「符不符合格式规范」,管不了显示效果(溢出、遮挡、字体替换)和设计质量。它也可能比
PowerPoint 更严,所以 PowerPoint 实测照样保留。

**实测**(2026-10-28,DocumentFormat.OpenXml 3.5.1,目标版本 Microsoft365):

| 文件                              | 错误数 | 主要问题                                                                                                                                                                                         |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DSH 编译的 Swiss Signal Grid 模板 | 22     | 19 处:`<br>` 编成了同一个 `<a:p>` 里的第二个 `<a:pPr>`(应为 `<a:br/>` 或新段落);2 处:柱状图 `barChart` 子元素顺序不对(`axId`);1 处:`presentation.xml` 里 `notesMasterIdLst` 排在 `sldIdLst` 之后 |
| Kimi WASM 编译的同一模板          | 1      | 同样的 `notesMasterIdLst` 顺序问题                                                                                                                                                               |
| Kimi 自带示例 yu7、DJI Pocket 4   | 0      | —                                                                                                                                                                                                |

`notesMasterIdLst` 的顺序问题两份实现里都有,这类文件 PowerPoint 一般照常能打开。所以验证器报错
不等于 PowerPoint 会弹修复,两者要分开看。这几份文件在 PowerPoint 里弹不弹修复,还没实测。

### 两种验证器比较

2026-10-28 实测。对象是上面 16 份同款导出,再加一份 city-cutout 故意改坏的副本。

- **OpenXmlValidator**:Open XML SDK,DocumentFormat.OpenXml 3.5.1,目标版本 Microsoft365。
- **XSD 脚本**:anthropics/skills `skills/pptx/scripts/office/validate.py`(`34040c9`),Python + lxml,
  带 ISO 29500 / ECMA XSD 和少量 Microsoft 扩展 XSD。

|                                            | OpenXmlValidator         | XSD 脚本                 |
| ------------------------------------------ | ------------------------ | ------------------------ |
| 16 份同款                                  | 0 错误                   | 全部通过                 |
| 幻灯片里 `spPr` / `nvSpPr` 顺序颠倒        | 报出,带 XPath            | **漏**                   |
| 坐标写成 `1.5`(应为整数)                   | 报出                     | **漏**                   |
| 一个段落两个 `<a:pPr>`(DSH 的 `<br>` bug)  | 报出                     | **漏**                   |
| `notesMasterIdLst` 排在 `sldIdLst` 后      | 报出                     | 不报(先把顺序摆正再校验) |
| `mc:Fallback` 里的 `p:transition` 属性非法 | 报出                     | **漏**                   |
| `mc:Choice` 里的平滑(`p159:morph`)写错     | 不报                     | 不报                     |
| 16 份用时                                  | 约 3 秒(含 `dotnet run`) | 约 3 秒                  |

- **覆盖面。** OpenXmlValidator 对每个部件都按完整 schema 查,还查一部分语义约束。XSD 脚本只对
  `presentation.xml`、主题、关系、内容类型这些做完整 XSD 校验。幻灯片只报一张白名单里的约 7 种错
  (`helpers/pptx_slide.py` 的 `FATAL_SLIDE_ERRORS`,是 PowerPoint 会拒开的那几种),其余照放。
  它的定位是「PowerPoint 打不打得开」,不是「合不合规范」。
- **扩展命名空间。** XSD 脚本把所有非 OOXML 命名空间的元素和属性删掉再校验,`mc:AlternateContent`
  整块不查。OpenXmlValidator 查 `mc:Fallback`,跳过它不认识的 `mc:Choice`。两者对平滑都**不误报,
  也都不查**;平滑写没写对还得靠 `check-pptx.mjs`(它已经核对每次平滑都带回退)。
- **误报。** OpenXmlValidator 更严:`notesMasterIdLst` 顺序这种 PowerPoint 照常打开的问题也报。
  XSD 脚本为了少误报主动放过了它。Orca 现在的导出没有备注母版,碰不到这一条。
- **能不能定位回 HTML。** OpenXmlValidator 给部件路径和 XPath(如 `/p:sld[1]/p:cSld[1]/p:spTree[1]/p:sp[2]`),
  按 XPath 找到形状,再看它的 `cNvPr name`:Orca 现在写的是 class 名(如 `t-body.t-on-glass`)或
  共享元素的 `!!键`。能定位到元素类别,还定位不到具体是哪一个元素;要精确,导出时得把元素身份写进
  `name` 或 `descr`。XSD 脚本的幻灯片报错只有消息文本,没有 XPath。
- **依赖和分发。** 两个都不在 Orca 的技术栈里(Node)。OpenXmlValidator 要 .NET 运行时(macOS、
  Windows 都能跑),不适合塞进 npm 包或桌面应用。XSD 脚本要 Python + lxml,同样不适合;而且
  **anthropics/skills 里 pptx skill 的 LICENSE 是专有许可**(受与 Anthropic 的协议约束),不能复制进
  开源的 Orca。XSD 文件本身来自 ECMA-376 标准,另外取得可以用。

**结论:**

1. **开发和 CI 用 OpenXmlValidator。** 改导出器时对 16 份同款跑一遍,新增错误就挡住。它查得全、
   报错带 XPath,`.NET` 只装在开发机和 CI 上。
2. **不随包分发验证器。** 用户机器上的检查继续由 `check-pptx.mjs` 负责。等 CI 里攒出导出器
   真犯过的错,再把对应的检查移植进 `check-pptx.mjs`(Node,没有新依赖)。
3. **不用 anthropics/skills 的 XSD 脚本。** 许可不允许复制进来,它在幻灯片上的覆盖也太窄。
   真要在 Node 里做 XSD 校验,另外评估 ECMA XSD 加一个 Node 的 XSD 库。
4. **导出时把元素身份写进形状的 `name` / `descr`。** 这样验证器和 PowerPoint 实测发现的问题都能
   对回 HTML 里的具体元素。

## 边界

创作链路仍以 HTML 为唯一的源,由导出器写 OOXML。

直接改 OOXML 只用于「编辑用户已有的 PPTX」(填公司模板、改现成稿),好保住没碰到的母版和
高级对象。有验证器兜底,让 agent 直接改 OOXML 在这个场景下可行。这是独立的能力,不和创作链路混用。
