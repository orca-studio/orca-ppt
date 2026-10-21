// 每种手法导出 PPTX 时回退成什么。这是 references/transitions.md「导出 PPTX」那张表的执行端，
// 不是第二份规范：表改了这里跟着改，skill-checks 的测试会逐条对一遍两边的档位。

/** 翻页级的手法（写在 section 上，决定这一页的 PowerPoint 转场）。 */
export const PAGE_TECHNIQUES = {
  shared: { name: "共享元素 / 形态变换", tier: "保真", kind: "morph" },
  "match-cut": { name: "匹配剪辑", tier: "保真", kind: "none" },
  "match-move": { name: "匹配放大", tier: "近似", kind: "morph" },
  mask: { name: "遮挡剪辑", tier: "近似", kind: "wipe" },
  split: { name: "一变多", tier: "近似", kind: "morph" },
  merge: { name: "多合一", tier: "近似", kind: "morph" },
  carry: { name: "元素交接", tier: "降级", kind: "fade" },
  "zoom-through": { name: "整页推近", tier: "降级", kind: "fade" },
  "zoom-into": { name: "放大进元素内部", tier: "降级", kind: "fade" },
  "zoom-match": { name: "推近匹配", tier: "降级", kind: "fade" },
  iris: { name: "遮挡变形", tier: "降级", kind: "fade" },
  recap: { name: "回顾片尾", tier: "丢失", kind: "fade" },
};

/** 元素级的手法（写在元素上，跟着这一页的转场走，只影响那几个元素）。 */
export const ELEMENT_TECHNIQUES = {
  turn: { name: "绕圆心转", tier: "保真" },
  swap: { name: "原地替换", tier: "保真" },
  flip: { name: "翻面", tier: "近似" },
  text: { name: "文字级匹配", tier: "降级" },
  roll: { name: "逐位滚轮", tier: "降级" },
};

/** 引擎和稿子里有、但表里没有对应项的东西，导出时一律报出来，不默默丢掉。 */
export const LOST = {
  // 说给看导出结果的人听：网页里是什么，PowerPoint 里变成什么
  rhythm: "新内容等主角到位才出现：PowerPoint 里会和翻页同时出现",
  anim: "页内动画：PowerPoint 里直接是放完的样子",
  video: "视频：PowerPoint 里是一张静止画面",
};

/**
 * 进入第 i 页的那次翻页用什么转场。facts 是在页面里量的：
 *   { st, autoAnimate, shared: [跟上一页共有的 data-id], match, turn, swap, flip, text, roll, duration, direction }
 * 返回 { kind, duration, dir, technique, tier, elements: [{ name, tier }] }
 */
export function pageTransition(facts) {
  const elements = [];
  for (const key of ["turn", "swap", "flip", "text", "roll"]) {
    if (facts[key]) elements.push(ELEMENT_TECHNIQUES[key]);
  }
  let technique = null;
  if (facts.st) {
    technique = PAGE_TECHNIQUES[facts.st];
    if (!technique) throw new Error(`data-st="${facts.st}" 在「导出 PPTX」表里没有对应项`);
  } else if (facts.autoAnimate && (facts.shared.length || facts.turn || facts.swap || facts.flip || facts.text)) {
    technique = PAGE_TECHNIQUES.shared;
  }
  // 原地替换、文字级匹配不写 data-st，也没有共享元素时：平滑会把同名元素交叉淡化
  const kind = technique?.kind ?? "none";
  const tiers = [technique?.tier, ...elements.map((e) => e.tier)].filter(Boolean);
  const order = ["保真", "近似", "降级", "丢失"];
  const tier = tiers.sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? "保真";
  // 遮挡剪辑：data-st-direction 是色块移动的方向（引擎没写时按 left），擦除朝同一个方向推。
  // OOXML 的 dir 也按移动方向写；PowerPoint 里实际朝哪边，留给 PowerPoint 校准核对
  const wipeDir = { left: "l", right: "r", up: "u", down: "d" }[facts.direction || "left"] ?? "l";
  return {
    kind,
    duration: facts.duration,
    ...(kind === "wipe" ? { dir: wipeDir } : {}),
    technique: technique?.name ?? null,
    tier,
    elements,
  };
}
