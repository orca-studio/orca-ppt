// orca-transition-skill 运行时。
//
// 转场分两类实现：
//   共享元素 / 形态变换 → reveal.js auto-animate（两页都写 data-auto-animate，元素用 data-id 配对），
//                         本文件补上旧元素退场和新元素入场（autoAnimateExtras），
//                         以及元素级的原地替换（data-swap）和文字级匹配（data-text）
//   目标页写 data-st="…" 的 → 本文件的 builders：
//     汇报稿：carry（元素交接）/ split（一变多）/ merge（多合一）/ match-move（匹配放大）/ match-cut（匹配剪辑，硬切）/ zoom-through（整页推近）/ zoom-into（放大进元素内部）/ mask（遮挡剪辑）
//     结尾页：recap（回顾片尾，配合 .s-recap 回顾屏和 .t-credits 名单）
//     故事稿：zoom-match（推近匹配）/ iris（遮挡变形）
//
// 页内动画（不是转场）：data-path 关键帧路径、data-light / data-lit 光束遮罩，进页后自己动，和场景时间线同一条路（buildsFor）
//
// data-st 页的做法：reveal 在这里是硬切。切页瞬间把上一页的内容克隆成 ghost 层，
// 放在新页里，第一帧和上一页完全一样，所以硬切看不出来；再用 GSAP 把 ghost 交接给新内容。
//
// 放映模式：翻页正常播放。
// 录制模式（URL 带 ?capture）：动画全部暂停，由 scripts/capture.mjs 调 __capture.seek(ms) 逐帧推进。
(() => {
  const CAPTURE = new URLSearchParams(location.search).has("capture");
  // 录制模式下，引擎改动页面（包层、插 ghost、搭灯的支架）之前，先给每个元素记下它在源文件里的位置
  // （从 .slides 起一路 :nth-child）。导出 PPTX 按它把每个形状对回稿子里的元素；复制出来的 ghost 带着原件的
  if (CAPTURE) {
    const slides = document.querySelector(".reveal .slides");
    for (const el of slides?.querySelectorAll("*") ?? []) {
      const path = [];
      for (let n = el; n !== slides; n = n.parentElement) path.unshift(`:nth-child(${[...n.parentElement.children].indexOf(n) + 1})`);
      el.dataset.pptxSrc = `.reveal .slides > ${path.join(" > ")}`;
    }
  }
  // 被回顾屏（.s-recap）嵌着放的那一份：不接键盘，不再嵌自己。总是和 ?capture 一起出现
  const EMBED = new URLSearchParams(location.search).has("embed");
  // 减少动效。**显式开关**:URL 带 ?calm,或 <html> / <body> 上写 data-motion="calm"。
  // 不跟系统的 prefers-reduced-motion 走 —— 放映时是演讲者电脑上的设置在决定观众看到什么,
  // 观众并没有选过;自动退化等于演讲者不知情地把稿子的价值关掉了。录制模式忽略它。
  // 开了之后:大幅缩放的手法(整页推近、放大进元素、推近匹配)换成短淡化,运动模糊关掉;
  // 共享元素、形态变换、一变多、多合一、元素交接照旧 —— 它们是讲清前后关系的那部分。
  const CALM =
    !CAPTURE &&
    (new URLSearchParams(location.search).has("calm") ||
      document.documentElement.dataset.motion === "calm" ||
      document.body?.dataset.motion === "calm");
  const CALM_REPLACE = new Set(["zoom-through", "zoom-into", "zoom-match", "recap"]);
  const CALM_FADE_S = 0.4;
  const W = 1920;
  const H = 1080;

  const DURATION = { mask: 1.0 };
  // 作者写的数值超出规范范围：夹回范围内，并在控制台说清楚（不夹的话匹配放大会放出画布）
  const ranged = (kind, attr, v, lo, hi) => {
    if (v >= lo && v <= hi) return v;
    const c = Math.min(hi, Math.max(lo, v));
    console.warn(`[orca-transition-skill] ${kind} 的 ${attr}="${v}" 超出 ${lo} 到 ${hi}，按 ${c} 处理`);
    return c;
  };
  const VECTOR = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

  // GSAP 拿到空数组会在控制台警告「target not found」，混进自检报告里。空的就跳过
  const timeline = () => {
    const tl = gsap.timeline({ paused: true });
    const proxy = new Proxy(tl, {
      get(target, prop) {
        const v = target[prop];
        if (typeof v !== "function") return v;
        if (!["to", "from", "fromTo", "set"].includes(prop)) return v.bind(target);
        return (targets, ...rest) => {
          if (!(Array.isArray(targets) && targets.length === 0)) v.call(target, targets, ...rest);
          return proxy;
        };
      },
    });
    return proxy;
  };

  // ───────── 运动模糊 ─────────
  // 模拟 30fps、180° 快门：曝光 1/60 秒，元素在这段时间里移动多少像素，就糊多长。
  // 模糊量都从时间线当前时刻算出来，所以逐帧录制时是确定的。
  const SHUTTER = 1 / 60;
  let blurSvg = null;
  let blurSeq = 0;
  const blurred = new Set();

  // 单方向模糊（SVG 高斯模糊只在一个轴上有值）。返回一个设置函数，参数是速度（px/s）
  function directionalBlur(els, axis, max = 10) {
    if (!els.length || CALM) return () => {};
    if (!blurSvg) {
      blurSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      blurSvg.setAttribute("width", "0");
      blurSvg.setAttribute("height", "0");
      blurSvg.style.position = "absolute";
      document.body.append(blurSvg);
    }
    const id = `st-mb-${blurSeq++}`;
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.id = id;
    // 滤镜区域放宽，否则糊出去的部分会被元素边框裁掉
    for (const [k, v] of [["x", "-50%"], ["y", "-50%"], ["width", "200%"], ["height", "200%"]]) filter.setAttribute(k, v);
    const gauss = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    gauss.setAttribute("in", "SourceGraphic");
    gauss.setAttribute("stdDeviation", "0 0");
    filter.append(gauss);
    blurSvg.append(filter);
    for (const el of els) {
      el.style.filter = `url(#${id})`;
      blurred.add(el);
    }
    return (speed) => {
      const sd = Math.min(max, (speed * SHUTTER) / 2);
      gauss.setAttribute("stdDeviation", axis === "x" ? `${sd} 0` : `0 ${sd}`);
    };
  }

  // 各向同性模糊（缩放用）。元素本身有 scale 时，CSS 滤镜会跟着被放大，所以要除回去
  function isoBlur(els, px, scale = 1) {
    if (CALM) return;
    for (const el of els) {
      el.style.filter = px > 0.05 ? `blur(${px / scale}px)` : "";
      blurred.add(el);
    }
  }

  function clearBlur() {
    for (const el of blurred) el.style.filter = "";
    blurred.clear();
    blurSvg?.replaceChildren();
  }

  const layer = (cls) => {
    const d = document.createElement("div");
    d.className = `st-layer ${cls}`;
    return d;
  };

  // 加载时的准备对整份稿子做一遍；宿主换掉一页时（__orcaReplaceSlide）只对那一页再做一遍
  const allSlides = () => [...document.querySelectorAll(".reveal .slides > section")];
  const within = (slides, sel) => slides.flatMap((s) => [...s.querySelectorAll(sel)]);

  // data-st 页：把原内容包进 .st-enter，方便整体移动
  function prepare(slides = allSlides()) {
    for (const section of slides) {
      // data-st 页自动补上 data-auto-animate + restart：reveal 不会从上一页自动动画进来（由 GSAP 接管），
      // 但下一页仍然可以从这一页做共享元素。
      if (section.dataset.st) {
        section.setAttribute("data-auto-animate", "");
        section.setAttribute("data-auto-animate-restart", "");
      }
      if (section.hasAttribute("data-auto-animate")) section.setAttribute("data-auto-animate-unmatched", "false");
    }
    markTurns();
    for (const section of slides.filter((s) => s.dataset.st)) {
      const enter = layer("st-enter");
      enter.append(...section.childNodes);
      section.append(enter);
    }
  }

  // 绕圆心转：rotate 绕 transform-origin 转，而 auto-animate 不管位置变没变都把它设成
  // top left !important，扇形就绕盒子左上角甩出去（录制时这条样式一直留着，扇形停在画面外）。
  // 标上 data-st-turn，由 tokens.css 里更具体的 !important 规则压回来：默认绕盒子中心，
  // 作者自己写了 transform-origin（比如指针绕底端）就用作者的
  // 只标真的转了的：整份稿子里这个元素（按 data-id 认）至少有一页角度不是 0。
  // 全程 0° 的元素照 reveal 默认绕左上角变形 —— 改成绕中心后，又平移又缩放的元素中途会冲出原来的范围。
  // 这是跨页的：换掉一页可能让别的页上同 data-id 的元素开始转、或者不再转，所以每次都整份重标
  // 角度取最后一段：「30deg」和绕轴的「y 34deg」都认（3D 转角也绕盒子中心转，开窗的两张图才对称）
  const turnAngle = (el) => parseFloat(el.style.rotate.trim().split(/\s+/).pop()) || 0;
  function markTurns() {
    const els = document.querySelectorAll(".reveal .slides > section [style*='rotate']");
    const turned = new Set();
    for (const el of els) {
      if (el.dataset.id && turnAngle(el)) turned.add(el.dataset.id);
    }
    for (const el of els) {
      if (!el.style.rotate || (!turnAngle(el) && !turned.has(el.dataset.id))) {
        delete el.dataset.stTurn;
        continue;
      }
      el.dataset.stTurn = "";
      // 只在第一次标的时候记：auto-animate 放过之后元素上留着它写的 transform-origin，那不是作者的
      if (!el.style.getPropertyValue("--st-origin"))
        el.style.setProperty("--st-origin", el.style.transformOrigin || "50% 50%");
    }
  }

  // 上一页的内容：data-st 页包在 .st-enter 里
  const contentOf = (sec) => sec.querySelector(":scope > .st-enter") ?? sec;
  const isRuntime = (el) => el.matches(".st-ghost, .st-ghost-el, .st-mask, .st-enter, .st-guide");

  function ghostClone(child) {
    const clone = child.cloneNode(true);
    // 视频的克隆体停在原视频当时那一帧（克隆出来的 <video> 默认从 0 开始，淡出时会跳回第一帧）
    const vids = [...(child.matches("video") ? [child] : []), ...child.querySelectorAll("video")];
    const cvids = [...(clone.matches("video") ? [clone] : []), ...clone.querySelectorAll("video")];
    vids.forEach((v, i) => { cvids[i].pause(); cvids[i].currentTime = v.currentTime; });
    // 去掉 reveal 配对用的标记，避免克隆体被 auto-animate 当成共享元素
    for (const el of [clone, ...clone.querySelectorAll("*")]) {
      el.removeAttribute("data-id");
      el.removeAttribute("data-auto-animate-target");
      el.removeAttribute("id");
    }
    return clone;
  }

  function snapshot(prev, keep = () => true) {
    const ghost = layer("st-ghost");
    for (const child of contentOf(prev).children) {
      if (isRuntime(child) || !keep(child)) continue;
      ghost.append(ghostClone(child));
    }
    return ghost;
  }

  const center = (el) => [el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2];
  // 不比 outerHTML：GSAP 会往 style 里写 opacity / transform，浏览器还会重排 style 文本
  const signature = (el) => [
    el.tagName, el.className, el.textContent.trim(), el.getAttribute("src") ?? "",
    el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight,
  ].join("|");
  const rectOf = (el) => ({ l: el.offsetLeft, t: el.offsetTop, r: el.offsetLeft + el.offsetWidth, b: el.offsetTop + el.offsetHeight });

  const builders = {
    // 匹配剪辑：硬切，一帧动画都不加。
    // 前后两页各有一个形状、大小、位置都相同的锚（data-match），切过去时观众的视线被锚钉住，
    // 页面其余部分可以全换。引擎在这里不做动画 —— 它只负责校验两页的锚是不是真的对上了，
    // 因为没有运动可以遮丑，差几个像素观众就会觉得「跳了一下」。
    "match-cut"(section, ghost, enter) {
      const key = section.dataset.stMatch;
      if (!key) {
        console.error(`[orca-transition-skill] match-cut 需要 data-st-match="键"，前后两页的锚写同样的 data-match="键"`);
        ghost.remove();
        return timeline();
      }
      const sel = `[data-match="${key}"]`;
      const olds = [...ghost.querySelectorAll(sel)];
      const news = [...enter.querySelectorAll(sel)];
      if (!olds.length || !news.length) {
        console.error(`[orca-transition-skill] match-cut 找不到 ${sel}（前后两页都要有）`);
        ghost.remove();
        return timeline();
      }
      // 锚可以是一组元素（圆和圆里的字），按整组的外接框比
      const bbox = (els) => {
        const r = els.map(rectOf);
        return {
          l: Math.min(...r.map((x) => x.l)), t: Math.min(...r.map((x) => x.t)),
          r: Math.max(...r.map((x) => x.r)), b: Math.max(...r.map((x) => x.b)),
        };
      };
      const A = bbox(olds);
      const B = bbox(news);
      const dim = (x) => ({ w: x.r - x.l, h: x.b - x.t, cx: (x.l + x.r) / 2, cy: (x.t + x.b) / 2 });
      const a = dim(A);
      const b = dim(B);

      const off = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (off > 8) {
        console.warn(`[orca-transition-skill] match-cut "${key}" 前后锚中心相差 ${Math.round(off)}px。硬切没有运动遮丑，对不齐就是跳帧，把两页的锚摆到同一个位置`);
      }
      const rel = (x, y) => Math.abs(x - y) / Math.max(x, y, 1);
      if (rel(a.w, b.w) > 0.04 || rel(a.h, b.h) > 0.04) {
        console.warn(`[orca-transition-skill] match-cut "${key}" 前后锚尺寸不一样（${Math.round(a.w)}×${Math.round(a.h)} → ${Math.round(b.w)}×${Math.round(b.h)}）。要变大小的是匹配放大（match-move），不是匹配剪辑`);
      }
      // 单个元素时连圆角一起比：胶囊切成方块，形状就不算对上。
      // 隐形锚（.s-anchor，用来标出视频画面里那个形状的位置）本身没有轮廓，跳过这一条
      const invisible = (el) => {
        const cs = getComputedStyle(el);
        return cs.visibility === "hidden" || +cs.opacity === 0;
      };
      if (olds.length === 1 && news.length === 1 && !invisible(olds[0]) && !invisible(news[0])) {
        const radius = (el) => getComputedStyle(el).borderRadius;
        if (radius(olds[0]) !== radius(news[0])) {
          console.warn(`[orca-transition-skill] match-cut "${key}" 前后锚圆角不一样（${radius(olds[0])} → ${radius(news[0])}），轮廓对不上就看不出是同一个形状`);
        }
      }
      // 形状一样还不够，里面得换了东西，否则这一刀观众根本感觉不到
      if (olds.length === news.length && olds.every((el, i) => signature(el) === signature(news[i]))) {
        console.warn(`[orca-transition-skill] match-cut "${key}" 前后锚完全一样，观众看不出切过页。匹配剪辑要「形状不变、内容换掉」，内容也不变就用共享元素`);
      }

      ghost.remove();
      return timeline();
    },

    mask(section, ghost, enter) {
      const d = +section.dataset.stDuration || DURATION.mask;
      if (!section.dataset.stDirection) {
        console.warn(`[orca-transition-skill] 遮挡剪辑没写 data-st-direction，按 left 处理。规范默认写 up（换话题从下往上盖）`);
      }
      const [vx, vy] = VECTOR[section.dataset.stDirection || "left"];
      const mask = document.createElement("div");
      mask.className = "st-mask";
      // 只接受设计变量名：accent / surface / surface-2 / bg / accent-soft
      if (section.dataset.stMaskColor) mask.style.background = `var(--${section.dataset.stMaskColor})`;
      section.append(mask);
      if (section.dataset.stMaskLead) return maskLead(section, ghost, enter, mask, vx, vy);
      const half = d / 2;
      // 色块从一侧加速盖满，盖满的那一帧换内容，再沿同方向减速离开
      gsap.set(enter, { autoAlpha: 0 });
      gsap.set(mask, { x: -vx * W, y: -vy * H });
      return timeline()
        .fromTo(mask, { x: -vx * W, y: -vy * H }, { x: 0, y: 0, duration: half, ease: "power3.in" }, 0)
        .set(ghost, { autoAlpha: 0 }, half)
        .set(enter, { autoAlpha: 1 }, half)
        .to(mask, { x: vx * W, y: vy * H, duration: half, ease: "power3.out" }, half);
    },
  };

  // 遮挡剪辑带领头元素（data-st-mask-lead="键"，上一页的元素写 data-lead="键"）：
  // 上一页的那个元素（手电筒）从它停下的姿态起步，往色块推进的方向走出画面，色块的前沿贴着它的背面一起进来 ——
  // 看起来是它把下一页拉出来。WPS 里是「缓慢移出」和「缓慢进入 · 自右侧」同时放。
  // 和普通遮挡剪辑不同，色块铺满后不离开：下一页的底就是这块色（data-st-mask-color 写成下一页的底色），
  // 铺满那一帧换上下一页，看不出切。
  //   前沿起步时在画外，领头元素一动，前沿先用 CATCH 这一段追上它的背面，之后一直贴着。
  const MASK_LEAD_D = 1.4;
  const MASK_LEAD_CATCH = 0.3;
  function maskLead(section, ghost, enter, mask, vx, vy) {
    const key = section.dataset.stMaskLead;
    const d = +section.dataset.stDuration || MASK_LEAD_D;
    const src = ghost.querySelector(`:scope > [data-lead="${key}"]`);
    if (!src) {
      console.error(`[orca-transition-skill] data-st-mask-lead="${key}" 在上一页找不到 data-lead="${key}" 的元素（要写在页面的直接子元素上）`);
    }
    // 领头元素搬出 ghost、放到色块上面。套一层铺满画布的壳来平移：元素自己的 transform 是它停下的姿态，不能动
    const rig = layer("st-ghost-el");
    rig.style.zIndex = 11; // 色块（.st-mask）是 10，领头元素压在它上面
    if (src) {
      rig.append(src);
      section.append(rig);
    }
    const horiz = vx !== 0;
    const sgn = horiz ? vx : vy;
    const size = horiz ? W : H;
    // 背面：迎着色块的那一侧（色块往左推，就是元素的右边）
    let trail0 = sgn < 0 ? size : 0;
    if (src) {
      const box = section.getBoundingClientRect(), r = src.getBoundingClientRect();
      const k = section.offsetWidth / (box.width || 1);
      const l = (r.left - box.left) * k, t = (r.top - box.top) * k, rr = (r.right - box.left) * k, b = (r.bottom - box.top) * k;
      trail0 = sgn < 0 ? (horiz ? rr : b) : (horiz ? l : t);
    }
    const edge0 = sgn < 0 ? size : 0;    // 前沿起点：画外
    const edgeEnd = sgn < 0 ? 0 : size;  // 前沿终点：铺满
    const gap0 = edge0 - trail0;         // 起步时前沿离背面多远（追上之后是 0）
    const travel = edgeEnd - trail0;     // 领头元素走多远：背面走到画面另一头，整个出画
    const clock = { p: 0, q: 0 };
    const apply = () => {
      const lead = travel * clock.p;
      const edge = trail0 + lead + gap0 * (1 - clock.q);
      const m = sgn < 0 ? edge : edge - size;
      gsap.set(mask, horiz ? { x: m, y: 0 } : { x: 0, y: m });
      gsap.set(rig, horiz ? { x: lead } : { y: lead });
    };
    gsap.set(enter, { autoAlpha: 0 });
    apply();
    // 缓慢移出 / 缓慢进入：领头元素从静止起步，一路减速到铺满
    // 上一页被光照着的那一层停在旧的光束里，不会跟着走：灯一动先把光收掉（关灯再走）
    return timeline()
      .to(ghost.querySelectorAll(":scope > [data-lit]"), { autoAlpha: 0, duration: 0.2, ease: "power1.out" }, 0)
      .to(clock, { p: 1, duration: d, ease: "power2.inOut", onUpdate: apply }, 0)
      .to(clock, { q: 1, duration: d * MASK_LEAD_CATCH, ease: "power2.out", onUpdate: apply }, 0)
      .set(ghost, { autoAlpha: 0 }, d)
      .set(enter, { autoAlpha: 1 }, d)
      .set([mask, rig], { autoAlpha: 0 }, d);
  }

  // 元素级速度匹配：不推整页。data-carry 相同的元素成对交接——
  // 旧的加速离开并淡出，新的从另一侧同速度减速进入；按 data-carry 首次出现的顺序错开。
  // 没写 data-carry 的元素原地交叉淡化（前后两页一模一样的面板因此看不出变化）。
  builders.carry = (section, ghost, enter) => {
    const d = +section.dataset.stDuration || 1.0;
    const half = d / 2;
    if (section.dataset.stDistance) {
      console.warn(`[orca-transition-skill] 元素交接写了 data-st-distance，规范不建议写：滑动距离由引擎按版式算`);
    }
    const maxDist = +section.dataset.stDistance || 240;
    const MIN_DIST = 80;
    const [vx, vy] = VECTOR[section.dataset.stDirection || "left"];
    const stagger = 0.06;
    const newEls = [...enter.children];
    const oldEls = [...ghost.children];
    const keys = [...new Set([...newEls, ...oldEls].map((el) => el.dataset.carry).filter(Boolean))];
    const tl = timeline();

    // 不交接的元素：前后一样的原地不动；不一样的，旧的淡出、新的淡入（同时进行，不突然消失）
    const newSigs = new Set(newEls.map(signature));
    const oldSigs = new Set(oldEls.map(signature));
    const newStill = newEls.filter((el) => !el.dataset.carry);
    const oldStill = oldEls.filter((el) => !el.dataset.carry);
    // 新页整层在旧页上面，所以新页的元素一开始全部隐藏；
    // 相同的元素由旧页那份撑到最后一刻再换，否则新面板会把旧面板里还没走的内容盖住
    gsap.set(newEls, { autoAlpha: 0 });
    const sameNew = newStill.filter((el) => oldSigs.has(signature(el)));
    tl.to(newStill.filter((el) => !oldSigs.has(signature(el))), { autoAlpha: 1, duration: half, ease: "power1.inOut" }, half * 0.5);
    tl.to(oldStill.filter((el) => !newSigs.has(signature(el))), { autoAlpha: 0, duration: half, ease: "power1.inOut" }, 0);
    tl.set(sameNew, { autoAlpha: 1 }, d);
    tl.set(oldStill, { autoAlpha: 0 }, d);

    // 滑动距离不能让元素滑出它所在的容器（包住它的不动元素，比如面板；没有就是安全区）。
    // 一组交接元素共用一个距离，前后速度才对得上。
    const containers = [...newStill, ...oldStill].map(rectOf);
    const roomFor = (el) => {
      const e = rectOf(el);
      const box = containers
        .filter((c) => c.l <= e.l && c.t <= e.t && c.r >= e.r && c.b >= e.b && (c.r - c.l) * (c.b - c.t) > (e.r - e.l) * (e.b - e.t))
        .sort((a, b) => (a.r - a.l) * (a.b - a.t) - (b.r - b.l) * (b.b - b.t))[0]
        ?? { l: 40, t: 40, r: W - 40, b: H - 40 };
      // 旧元素朝 v 方向离开，新元素从 -v 方向进来；两个方向的余量都要算
      return vx ? Math.min(e.l - box.l, box.r - e.r) : Math.min(e.t - box.t, box.b - e.b);
    };

    keys.forEach((key, i) => {
      const t = i * stagger;
      const olds = oldEls.filter((el) => el.dataset.carry === key);
      const news = newEls.filter((el) => el.dataset.carry === key);
      const room = Math.min(...[...olds, ...news].map(roomFor));
      const dist = Math.max(MIN_DIST, Math.min(maxDist, room));
      // 透明度比位移先走完：元素还没到终点就已经看不见，不会压到容器边上
      const axis = vx ? "x" : "y";
      const blurOld = directionalBlur(olds, axis);
      const blurNew = directionalBlur(news, axis);
      // power2 曲线的速度：加速段 2p·dist/half，减速段 2(1-p)·dist/half
      if (olds.length) {
        tl.fromTo(olds, { x: 0, y: 0 }, {
          x: vx * dist, y: vy * dist, duration: half, ease: "power2.in",
          onUpdate() { blurOld((2 * this.progress() * dist) / half); },
        }, t);
        tl.fromTo(olds, { autoAlpha: 1 }, { autoAlpha: 0, duration: half * 0.7, ease: "power1.in" }, t + half * 0.3);
      }
      if (news.length) {
        tl.fromTo(news, { x: -vx * dist, y: -vy * dist }, {
          x: 0, y: 0, duration: half, ease: "power2.out",
          onUpdate() { blurNew((2 * (1 - this.progress()) * dist) / half); },
        }, half + t);
        tl.fromTo(news, { autoAlpha: 0 }, { autoAlpha: 1, duration: half * 0.7, ease: "power1.out" }, half + t);
      }
    });
    return tl;
  };

  // 带运动的匹配剪辑：匹配组（data-match 相同的元素）以锚点中心放大，
  // 放到最大的那一帧换成下一页的匹配组，再从同样的大小回落。其余内容先退后进。
  builders["match-move"] = (section, ghost, enter) => {
    const d = +section.dataset.stDuration || 0.9;
    const half = d / 2;
    const peak = section.dataset.stScale ? ranged("match-move", "data-st-scale", +section.dataset.stScale, 1.3, 2) : 1.5;
    const sel = `[data-match="${section.dataset.stMatch}"]`;
    const olds = [...ghost.querySelectorAll(sel)];
    const news = [...enter.querySelectorAll(sel)];
    if (!olds.length || !news.length) {
      console.error(`[orca-transition-skill] match-move 找不到 ${sel}（前后两页都要有）`);
      return timeline();
    }
    const [ax, ay] = center(olds[0]);
    const [bx, by] = center(news[0]);
    if (Math.hypot(ax - bx, ay - by) > 40) {
      console.warn(`[orca-transition-skill] match-move 前后锚点中心相差 ${Math.round(Math.hypot(ax - bx, ay - by))}px`);
    }
    const origin = (cx, cy) => (i, el) => `${cx - el.offsetLeft}px ${cy - el.offsetTop}px`;
    // 前后两页完全相同的元素（比如同位置的面板）原地不动
    const newSigs = new Set([...enter.children].map(signature));
    const oldSigs = new Set([...ghost.children].map(signature));
    const oldRest = [...ghost.children].filter((el) => !olds.includes(el) && !newSigs.has(signature(el)));
    const newRest = [...enter.children].filter((el) => !news.includes(el) && !oldSigs.has(signature(el)));
    const sameNew = [...enter.children].filter((el) => !news.includes(el) && oldSigs.has(signature(el)));

    // 匹配组边缘离缩放中心的距离，决定边缘的线速度
    const reach = Math.max(...olds.map((el) => Math.max(el.offsetWidth, el.offsetHeight) / 2));
    gsap.set(olds, { transformOrigin: origin(ax, ay) });
    gsap.set(news, { autoAlpha: 0, scale: peak, transformOrigin: origin(bx, by) });
    if (newRest.length) gsap.set(newRest, { autoAlpha: 0, y: 24 });
    if (sameNew.length) gsap.set(sameNew, { autoAlpha: 0 });

    return timeline()
      .to(olds, {
        scale: peak, duration: half, ease: "power2.in",
        onUpdate() {
          const q = this.progress();
          const speed = ((peak - 1) * 2 * q / half) * reach;
          isoBlur(olds, Math.min(6, (speed * SHUTTER) / 3), 1 + (peak - 1) * q * q);
        },
      }, 0)
      .to(oldRest, { autoAlpha: 0, duration: half * 0.8, ease: "power1.in" }, 0)
      .set(ghost, { autoAlpha: 0 }, half)
      .set(news, { autoAlpha: 1 }, half)
      .set(sameNew, { autoAlpha: 1 }, half)
      .to(news, {
        scale: 1, duration: half, ease: "power2.out",
        onUpdate() {
          const q = this.progress();
          const speed = ((peak - 1) * 2 * (1 - q) / half) * reach;
          isoBlur(news, Math.min(6, (speed * SHUTTER) / 3), peak - (peak - 1) * (1 - (1 - q) * (1 - q)));
        },
      }, half)
      .to(newRest, { autoAlpha: 1, y: 0, duration: half, ease: "power2.out", stagger: 0.04 }, half + 0.1);
  };

  // 整页推近（汇报稿版交叉缩放）：把画布当成一张照片，旧页整层以 data-zoom="from" 元素为中心加速推近，
  // 推到它占满大半屏的那一帧换成新页；新页以 data-zoom="to" 元素（不写就是画面中心）为中心、同样的倍数减速拉回。
  // 两段都在对数尺度上插值缩放倍数、曲线同阶，切点两边速度相等。镜头不会让画布边缘露出来。
  builders["zoom-through"] = (section, ghost, enter) => {
    const d = +section.dataset.stDuration || 1.4;
    const half = d / 2;
    const fromKey = section.dataset.stFrom;
    const toKey = section.dataset.stTo;
    const a = fromKey && ghost.querySelector(`[data-zoom="${fromKey}"]`);
    if (!a) {
      console.error(`[orca-transition-skill] zoom-through 需要 data-st-from，并且上一页有 data-zoom="${fromKey}" 的元素`);
      return timeline();
    }
    const b = toKey ? enter.querySelector(`[data-zoom="${toKey}"]`) : null;
    if (toKey && !b) console.error(`[orca-transition-skill] zoom-through 这一页找不到 data-zoom="${toKey}"，改用画面中心`);
    // 推近倍数：让 from 元素占满画面约 75%（按 16:9 折算），限制在 2 到 8 倍
    const fit = (el) => 0.75 * W / Math.max(el.offsetWidth, el.offsetHeight * W / H);
    const K = section.dataset.stScale ? ranged("zoom-through", "data-st-scale", +section.dataset.stScale, 2, 8) : Math.min(8, Math.max(2, fit(a)));
    if (fit(a) < 2 && !section.dataset.stScale) {
      console.warn(`[orca-transition-skill] zoom-through 的 "${fromKey}" 太大，推近不到 2 倍，推进感会弱。换一个更小的元素`);
    }
    const [ax, ay] = center(a);
    const [bx, by] = b ? center(b) : [W / 2, H / 2];

    const clampCam = ({ cx, cy, k }) => ({
      k,
      cx: Math.min(W - W / (2 * k), Math.max(W / (2 * k), cx)),
      cy: Math.min(H - H / (2 * k), Math.max(H / (2 * k), cy)),
    });
    const lerp = (x, y, q) => x + (y - x) * q;
    const camAt = (t) => {
      if (t < half) {
        const q = gsap.parseEase("power2.in")(t / half);
        return clampCam({ k: Math.exp(Math.log(K) * q), cx: lerp(W / 2, ax, q), cy: lerp(H / 2, ay, q) });
      }
      const q = gsap.parseEase("power2.out")((t - half) / half);
      return clampCam({ k: Math.exp(Math.log(K) * (1 - q)), cx: lerp(bx, W / 2, q), cy: lerp(by, H / 2, q) });
    };
    const apply = (el, { cx, cy, k }) =>
      gsap.set(el, { x: W / 2 - cx * k, y: H / 2 - cy * k, scale: k, transformOrigin: "0 0" });

    const p = { t: 0 };
    const render = () => {
      const layerNow = p.t < half ? ghost : enter;
      const cam = camAt(p.t);
      apply(layerNow, cam);
      // 运动模糊：画面边缘（离中心半屏）一帧曝光时间里移动的距离
      const dt = 1 / 240;
      const k2 = camAt(Math.min(d, p.t + dt)).k;
      const edgeSpeed = (Math.abs(k2 - cam.k) / dt / cam.k) * (W / 2);
      isoBlur([layerNow], Math.min(8, (edgeSpeed * SHUTTER) / 4), cam.k);
    };
    gsap.set(enter, { autoAlpha: 0 });
    render();
    return timeline()
      .to(p, { t: d, duration: d, ease: "none", onUpdate: render }, 0)
      .set(ghost, { autoAlpha: 0 }, half)
      .set(enter, { autoAlpha: 1 }, half);
  };

  // 放大进元素内部（语义缩放）。
  //   in ：上一页的 data-zoom 元素成为主角：页面被镜头缓慢推近一点、虚化并淡出，只剩这个元素一边长大、一边移到画面正中；
  //        长到够大后，下一页在元素的形状里显出来，元素铺满画面时下一页正好 1:1 铺满。
  //   out：反过来。这一页收进元素的形状里，元素一边缩小一边回到原位，页面其他内容淡入。
  // 页面只推近到 2 倍（推到几十倍时周围的格子、虚线框会被放得很大，抢主角），主角自己长到铺满。
  // 元素位置按屏幕上的实际位置算（包括场景镜头的变换），元素可以在 .mo-scene 里。
  builders["zoom-into"] = (section, ghost, enter) => {
    const d = +section.dataset.stDuration || 1.8;
    const dir = section.dataset.stDirection || "in";
    const key = dir === "in" ? section.dataset.stFrom : section.dataset.stTo;
    const outer = dir === "in" ? ghost : enter;   // 元素所在的那一页（淡出 / 淡入）
    const inner = dir === "in" ? enter : ghost;   // 在元素形状里的那一页
    const anchor = key && outer.querySelector(`[data-zoom="${key}"]`);
    if (!anchor) {
      console.error(`[orca-transition-skill] zoom-into（${dir}）找不到 data-zoom="${key}"：in 用 data-st-from 指上一页的元素，out 用 data-st-to 指这一页的元素`);
      return timeline();
    }
    // 元素在画布坐标里的位置：屏幕位置减去页面位置，再除以 reveal 的缩放
    const sr = section.getBoundingClientRect();
    const scale = sr.width / W;
    const er = anchor.getBoundingClientRect();
    const r = { x: (er.left - sr.left) / scale, y: (er.top - sr.top) / scale, w: er.width / scale, h: er.height / scale };
    // 元素的圆角（画布像素）：computed style 是元素自身尺寸下的值，按屏幕上的实际大小换算
    const rad = (parseFloat(getComputedStyle(anchor).borderTopLeftRadius) || 0) * (anchor.offsetWidth ? r.w / anchor.offsetWidth : 1);
    const cx0 = r.x + r.w / 2;
    const cy0 = r.y + r.h / 2;

    const ease = gsap.parseEase("power2.inOut");   // power3 起步太慢，前 0.4 秒像卡住
    const smooth = (x, a, b) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
    const qAt = (t) => { const e = ease(Math.min(1, t / d)); return dir === "in" ? e : 1 - e; };
    // q：0 = 元素在原位原大小，1 = 元素铺满画布。
    // 尺寸按比例（对数）插值：小元素长大时每一刻的放大速度一样，不会前面慢、最后一下猛冲；
    // 位置在前一半移到画面正中
    const rectAt = (q) => {
      const w = r.w * Math.pow(W / r.w, q);
      const h = r.h * Math.pow(H / r.h, q);
      const pan = smooth(q, 0, 0.5);
      const cx = cx0 + (W / 2 - cx0) * pan;
      const cy = cy0 + (H / 2 - cy0) * pan;
      return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
    };
    // 纵深：元素所在的那页被镜头缓慢推近（最多 PUSH 倍，data-st-push 可调，默认 2），镜头跟着主角走
    // （主角中心始终对着页面里元素的位置），同时轻微虚化、淡出。推得越深淡出越晚，让推近那段看得出来；
    // 推太深周围的格子会被放大到抢主角
    const PUSH = section.dataset.stPush ? ranged("zoom-into", "data-st-push", +section.dataset.stPush, 1, 4) : 2;
    const FADE = 0.05 * (PUSH - 2);                  // 每多推 1 倍，淡出往后挪 5%

    // 里面那页要有底色，否则透出后面的页；压在最上面
    inner.style.background = "var(--bg)";
    inner.style.zIndex = "3";
    outer.style.zIndex = "1";
    // 主角：元素的替身（同色、同圆角），在两页之间
    inner.parentNode.querySelectorAll(":scope > .st-zoom-hero").forEach((n) => n.remove());
    const cs = getComputedStyle(anchor);
    const hero = document.createElement("div");
    hero.className = "st-zoom-hero";
    Object.assign(hero.style, { position: "absolute", left: "0", top: "0", margin: "0", background: cs.backgroundColor,
      backgroundImage: cs.backgroundImage, zIndex: "2", pointerEvents: "none" });
    inner.parentNode.append(hero);

    const p = { t: 0 };
    const render = () => {
      const q = qAt(p.t);
      const R = rectAt(q);
      const round = Math.min(rad * (R.w / r.w), R.w / 2, R.h / 2) * (1 - smooth(q, 0.6, 0.9));
      Object.assign(hero.style, { width: `${R.w}px`, height: `${R.h}px`, borderRadius: `${round}px` });
      gsap.set(hero, { x: R.x, y: R.y });
      // 里面那页按「盖满元素」缩放、对准元素中心，裁成元素的形状；元素铺满画布时正好 1:1
      const s = Math.max(R.w / W, R.h / H);
      const tx = R.x + R.w / 2 - (W * s) / 2;
      const ty = R.y + R.h / 2 - (H * s) / 2;
      gsap.set(inner, { x: tx, y: ty, scale: s, transformOrigin: "0 0" });
      const L = (R.x - tx) / s, T = (R.y - ty) / s, RR = W - (R.x + R.w - tx) / s, B = H - (R.y + R.h - ty) / s;
      inner.style.clipPath = `inset(${T}px ${RR}px ${B}px ${L}px round ${round / s}px)`;
      // 先淡掉周围（主角还小的时候），主角长到够大后下一页才在它的形状里显出来；显完后替身藏起来
      const k = 1 + (PUSH - 1) * smooth(q, 0, 0.55);
      gsap.set(outer, { x: R.cx - cx0 * k, y: R.cy - cy0 * k, scale: k, transformOrigin: "0 0" });
      isoBlur([outer], 4 * smooth(q, 0.05 + FADE, 0.45 + FADE), k);
      outer.style.opacity = 1 - smooth(q, 0.1 + FADE, 0.45 + FADE);
      inner.style.opacity = smooth(q, 0.35, 0.7);
      hero.style.opacity = 1 - smooth(q, 0.7, 0.76);
      // 原来那个元素在替身离开期间藏起来，不然淡入 / 淡出的页面里会同时出现两个
      anchor.style.visibility = q > 0 ? "hidden" : "";
    };
    render();
    return timeline()
      .to(p, { t: d, duration: d, ease: "none", onUpdate: render }, 0)
      // 结束时新页回到原样，旧页和替身藏起来
      .set(enter, { clearProps: "transform,opacity,filter,background,zIndex,clipPath" }, d)
      .set(ghost, { autoAlpha: 0 }, d)
      .set(hero, { autoAlpha: 0 }, d)
      .set(anchor, { clearProps: "visibility" }, d);
  };

  // 新元素的入场方式（data-enter）。默认上浮淡入；图表用 grow-up / grow-right 从基线长出来
  const ENTER = {
    rise: { from: { autoAlpha: 0, y: 24 }, to: { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" } },
    "grow-up": { from: { scaleY: 0, transformOrigin: "50% 100%" }, to: { scaleY: 1, duration: 0.6, ease: "power3.out" } },
    "grow-right": { from: { scaleX: 0, transformOrigin: "0% 50%" }, to: { scaleX: 1, duration: 0.6, ease: "power3.out" } },
    pop: { from: { autoAlpha: 0, scale: 0.6 }, to: { autoAlpha: 1, scale: 1, duration: 0.5, ease: "back.out(1.6)" } },
  };
  // draw：<svg> 里的线（path / polyline / line）按顺序从起点画到终点，折线图用
  const DRAW = { duration: 0.9, stagger: 0.15 };
  function enterTween(tl, el, at) {
    const kind = el.dataset.enter || "rise";
    if (kind === "draw") {
      const lines = [...el.querySelectorAll("path, polyline, line")];
      if (el.tagName.toLowerCase() !== "svg" || !lines.length) {
        console.error(`[orca-transition-skill] data-enter="draw" 只能写在里面有 path / polyline / line 的 <svg> 上`);
        return;
      }
      lines.forEach((ln, i) => {
        const len = ln.getTotalLength();
        const start = at + i * DRAW.stagger;
        // 圆头线帽在虚线长度为 0 时仍会画出一个点，所以每条线轮到它画时才显示
        gsap.set(ln, { strokeDasharray: len, strokeDashoffset: len, autoAlpha: 0 });
        tl.set(ln, { autoAlpha: 1 }, start);
        tl.to(ln, { strokeDashoffset: 0, duration: DRAW.duration, ease: "power2.inOut" }, start);
      });
      return;
    }
    let spec = ENTER[kind];
    if (!spec) {
      console.error(`[orca-transition-skill] 不认识的 data-enter="${kind}"，可选：${[...Object.keys(ENTER), "draw"].join(" / ")}`);
      spec = ENTER.rise;
    }
    // 淡入淡到作者写的透明度（压在色块上的半透明装饰大字），不是一律淡到 1。
    // GSAP 跑完会把 opacity 写回行内，所以第一次见到时记下作者原来写的
    if (!AUTHORED_OPACITY.has(el)) AUTHORED_OPACITY.set(el, el.style.opacity === "" ? 1 : +el.style.opacity);
    const to = "autoAlpha" in spec.to ? { ...spec.to, autoAlpha: AUTHORED_OPACITY.get(el) } : { ...spec.to };
    const keep = keepRotate([el]);
    gsap.set(el, spec.from);
    keep?.();
    tl.to(el, { ...to, onUpdate: keep }, at);
  }
  const AUTHORED_OPACITY = new WeakMap();

  // 绕轴的 3D 转角（rotate: y 34deg）：GSAP 一碰 transform 就把独立的 rotate 折进 transform，
  // 写成 rotate(y 34deg) —— 不合法，整条 transform 作废，转角就没了。每帧把作者写的值写回去。
  // 平面的 rotate（30deg）GSAP 折得对，写回去反而转两次，不管
  const AUTHORED_ROTATE = new WeakMap();
  const AUTHORED_CLIP = new WeakMap();
  function keepRotate(els) {
    const list = els.filter((el) => {
      if (!AUTHORED_ROTATE.has(el)) AUTHORED_ROTATE.set(el, el.style.rotate);
      return AUTHORED_ROTATE.get(el).trim().includes(" ");
    });
    return list.length ? () => { for (const el of list) el.style.rotate = AUTHORED_ROTATE.get(el); } : undefined;
  }

  // 共享元素的裁剪形状（clip-path: polygon(…)）：reveal 不插值 clip-path，翻页一开始就跳成新形状。
  // 前后两页都在行内写了 polygon、顶点数相同，就跟着位置一起逐点插值。
  // 每个坐标拆成「百分比 + 像素」两部分（50%、12px、calc(100% - 12px) 都认），分别插值
  function clipPoints(clip) {
    const m = /^polygon\((.*)\)$/.exec(clip.trim());
    if (!m) return null;
    const length = (s) => {
      const v = [0, 0];
      const body = s.startsWith("calc(") ? s.slice(5, -1) : s;
      for (const [, sign, n, unit] of body.matchAll(/([+-]?)\s*([\d.]+)(%|px)?/g)) v[unit === "%" ? 0 : 1] += (sign === "-" ? -1 : 1) * +n;
      return v;
    };
    return m[1].split(",").map((pt) => (pt.match(/calc\([^)]*\)|\S+/g) ?? []).map(length));
  }
  function clipTween(tl, el, from, to, d, at) {
    const a = clipPoints(from);
    const b = clipPoints(to);
    if (!a || !b) return;
    if (a.length !== b.length) {
      console.warn(`[orca-transition-skill] data-id="${el.dataset.id}" 前后两页的 clip-path 顶点数不同（${a.length} 和 ${b.length}），形状不插值、直接跳过去`);
      return;
    }
    const lerp = (p, q, k) => p + (q - p) * k;
    const css = (k) => `polygon(${a.map((pt, i) => pt.map((v, j) =>
      `calc(${lerp(v[0], b[i][j][0], k).toFixed(3)}% + ${lerp(v[1], b[i][j][1], k).toFixed(2)}px)`).join(" ")).join(", ")})`;
    const state = { k: 0 };
    tl.fromTo(state, { k: 0 }, {
      k: 1, duration: d, ease: "power2.inOut", immediateRender: true,
      onUpdate: () => { el.style.clipPath = state.k === 1 ? to : css(state.k); },
    }, at);
  }


  // ───────── 元素级：原地替换（data-swap）和文字级匹配（data-text）─────────
  // 都发生在共享元素页（前后两页都写 data-auto-animate）内部，和页面上其他元素的移动同时进行。
  // 键相同的一对元素必须是两页的直接子元素，位置不变，只有内容换掉。

  const SWAP_D = 0.5;   // 原地替换：交叉溶解时长
  const TEXT_D = 0.9;   // 文字级匹配：留下的字移到新位置的时长
  const ROLL_D = 0.7;   // 文字级匹配的逐位滚轮（data-roll）：对齐参考作品「平滑」的 0.7 秒
  const PAIR_TOL = 40;  // 前后两页锚点允许的偏差（px）
  const SWAP_SIZE_RATIO = 2.5;  // 原地替换：两个对象尺寸差到这个倍数就提醒（形状不同是正常的）

  // 元素在页面坐标系里的位置（两页的元素都是 section 的直接子元素，offsetParent 相同）
  const offsetBox = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

  // 把纯文字元素拆成一个字一个 <span>，用来逐字测位置和逐字动画
  function charize(el) {
    const text = el.textContent;
    el.textContent = "";
    el.style.whiteSpace = "nowrap";
    const spans = [...text].map((ch) => {
      const s = document.createElement("span");
      s.textContent = ch === " " ? " " : ch;
      s.style.display = "inline-block";
      s.style.whiteSpace = "pre";
      el.append(s);
      return s;
    });
    return { chars: [...text], spans };
  }

  // 配对：缩写展开优先（A 的每个字按顺序对上 B 里每个词的首字母），对不上就退回最长公共子序列
  function matchChars(a, b) {
    const eq = (x, y) => x.toLowerCase() === y.toLowerCase();
    const initials = [];
    for (let i = 0; i < b.length; i++) {
      if (b[i] !== " " && (i === 0 || b[i - 1] === " ")) initials.push(i);
    }
    if (a.length > 1 && initials.length >= a.length && a.every((ch, i) => eq(ch, b[initials[i]]))) {
      return a.map((_, i) => [i, initials[i]]);
    }
    // LCS
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const pairs = [];
    for (let i = 0, j = 0; i < n && j < m;) {
      if (eq(a[i], b[j])) pairs.push([i++, j++]);
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  // 数字：前后缀相同、中间是数字时，用数值插值代替逐字配对
  const NUM_RE = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(\D*)$/;
  function numberParts(a, b) {
    const ma = NUM_RE.exec(a.trim());
    const mb = NUM_RE.exec(b.trim());
    if (!ma || !mb || ma[1] !== mb[1] || ma[3] !== mb[3]) return null;
    const dec = (mb[2].split(".")[1] || "").length;
    const group = mb[2].includes(",");
    const fmt = (v) => {
      const s = group
        ? v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })
        : v.toFixed(dec);
      return mb[1] + s + mb[3];
    };
    return { from: +ma[2].replace(/,/g, ""), to: +mb[2].replace(/,/g, ""), fmt };
  }

  // 逐位滚轮（data-roll）：前后缀相同、中间是纯数字。小数点、千分位不支持 —— 它们不是「一位」
  const ROLL_RE = /^(\D*?)(\d+)(\D*)$/;
  function rollParts(a, b) {
    const ma = ROLL_RE.exec(a.trim());
    const mb = ROLL_RE.exec(b.trim());
    if (!ma || !mb || ma[1] !== mb[1] || ma[3] !== mb[3]) return null;
    return { pre: mb[1], from: ma[2], to: mb[2], suf: mb[3] };
  }

  // 逐位滚轮：每一位是一条 0–9 的竖条，只露出一格（PPT 里是竖排文本框 + 上下遮挡矩形 + 平滑）。
  // 竖条的顺序固定是 0 在上、9 在下，所以数字变大往上滚、变小往下滚，中间经过的数字都露一下；
  // 没变的位不动。位数变了按个位对齐：多出来的位从 0 滚到目标并淡入，少掉的位滚回 0 并淡出。
  // 前缀、后缀的字只跟着移位置。整个过程由时间轴驱动，录制时逐帧 seek 也是确定的。
  // 返回 false = 配不上（不是纯数字、前后缀不同、字号不同），调用方退回普通的文字级匹配。
  function rollTween(tl, ghost, next, d) {
    const parts = rollParts(ghost.textContent, next.textContent);
    const fsA = parseFloat(getComputedStyle(ghost).fontSize);
    const fsB = parseFloat(getComputedStyle(next).fontSize);
    if (!parts || Math.abs(fsA - fsB) > 0.5) {
      console.warn(`[orca-transition-skill] 逐位滚轮 data-text="${next.dataset.text}" 前后两页要是「相同前后缀 + 纯数字」、字号相同，这次退回普通的文字级匹配`);
      return false;
    }
    const from = offsetBox(ghost);
    const to = offsetBox(next);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const boxes = (spans) => spans.map((sp) => ({ x: sp.offsetLeft, y: sp.offsetTop, w: sp.offsetWidth, h: sp.offsetHeight }));
    const A = boxes(charize(ghost).spans);
    const shadow = next.cloneNode(true);
    shadow.style.visibility = "hidden";
    next.after(shadow);
    const B = boxes(charize(shadow).spans).map((b) => ({ ...b, x: b.x + dx, y: b.y + dy }));
    shadow.remove();

    // 列：前缀逐字左对齐，数字按个位对齐，后缀逐字右对齐
    const pl = parts.pre.length, nA = parts.from.length, nB = parts.to.length, n = Math.max(nA, nB);
    const cols = [];
    for (let i = 0; i < pl; i++) cols.push({ a: i, b: i, ch: parts.pre[i] });
    for (let k = 0; k < n; k++) {
      const ia = k - (n - nA), ib = k - (n - nB);
      cols.push({
        a: ia >= 0 ? pl + ia : null, b: ib >= 0 ? pl + ib : null,
        va: ia >= 0 ? +parts.from[ia] : 0, vb: ib >= 0 ? +parts.to[ib] : 0, digit: true,
      });
    }
    for (let i = 0; i < parts.suf.length; i++) cols.push({ a: pl + nA + i, b: pl + nB + i, ch: parts.suf[i] });

    // 动画层：清掉旧字，盒子尺寸钉住，每列一个只露一格的窗口
    ghost.textContent = "";
    ghost.style.width = `${from.w}px`;
    ghost.style.height = `${from.h}px`;
    const colorB = getComputedStyle(next).color;
    tl.to(ghost, { color: colorB, duration: d, ease: "power2.inOut" }, 0);
    for (const c of cols) {
      const s0 = c.a !== null ? A[c.a] : B[c.b];
      const s1 = c.b !== null ? B[c.b] : A[c.a];
      const h = s0.h;
      const win = document.createElement("span");
      win.style.cssText = `position:absolute; left:${s0.x}px; top:${s0.y}px; width:${s0.w}px; height:${h}px; overflow:hidden;`;
      const strip = document.createElement("span");
      strip.style.cssText = "position:absolute; left:0; top:0; width:100%;";
      const cells = c.digit ? [..."0123456789"] : [c.ch];
      for (const ch of cells) {
        const cell = document.createElement("span");
        cell.textContent = ch;
        cell.style.cssText = `display:block; height:${h}px; line-height:${h}px; text-align:center; white-space:pre;`;
        strip.append(cell);
      }
      win.append(strip);
      ghost.append(win);
      tl.fromTo(win, { x: 0, y: 0, width: s0.w }, {
        x: s1.x - s0.x, y: s1.y - s0.y, width: s1.w, duration: d, ease: "power2.inOut",
      }, 0);
      if (!c.digit) continue;
      tl.fromTo(strip, { y: -c.va * h }, { y: -c.vb * h, duration: d, ease: "power2.inOut" }, 0);
      if (c.a === null) tl.fromTo(win, { autoAlpha: 0 }, { autoAlpha: 1, duration: d * 0.6, ease: "power1.out" }, 0);
      if (c.b === null) tl.to(win, { autoAlpha: 0, duration: d * 0.6, ease: "power1.in" }, d * 0.4);
    }
    return true;
  }

  // 元素自己有没有不透明的底（色块、卡片、图片）。
  function isOpaque(el) {
    if (/^(IMG|VIDEO|CANVAS|PICTURE)$/.test(el.tagName)) return true;
    const cs = getComputedStyle(el);
    if (cs.backgroundImage !== "none") return true;
    const c = cs.backgroundColor;
    if (!c || c === "transparent") return false;
    const slash = c.match(/\/\s*([\d.]+)(%?)\s*\)$/);             // oklch(… / 0.5)、rgb(… / 50%)
    if (slash) return parseFloat(slash[1]) * (slash[2] ? 0.01 : 1) >= 0.99;
    const rgba = c.match(/^rgba\((?:[^,]+,){3}\s*([\d.]+)\)$/);   // rgba(0, 0, 0, 0)
    if (rgba) return parseFloat(rgba[1]) >= 0.99;
    return true;                                                   // 不带 alpha 的写法都是不透明
  }

  // 原地替换：新的在原位淡入，不动不放大。
  // 两个都有不透明底时，旧的不跟着同时淡：两层各 50% 叠起来只盖住 75%，背景会透出来，
  // 中点那一帧整块发暗（实测橙牌换深色牌，中点是 (76,48,35)，两色平均该是 (132,78,45)）。
  // 旧的压在新的正下方（见上面 pairs 那段），保持不透明，新的淡入就是两色的线性混合，最后再藏。
  // 文字这类本身透明的照旧同时淡 —— 旧字一直不透明的话，会清楚地露在新字底下。
  function swapTween(tl, ghost, next, d) {
    gsap.set(next, { autoAlpha: 0 });
    tl.to(next, { autoAlpha: 1, duration: d, ease: "power1.inOut" }, 0);
    if (isOpaque(ghost) && isOpaque(next)) {
      // 排在最后一帧之前：录制最后一次 seek 落在 (帧数 - 1) / fps，正好 d 的话执行不到（同 textTween）
      tl.set(ghost, { autoAlpha: 0 }, Math.max(0, d - 1 / 30));
    } else {
      tl.to(ghost, { autoAlpha: 0, duration: d, ease: "power1.inOut" }, 0);
    }
  }

  // 文字级匹配：配上的字从旧位置移到新位置，没配上的旧字淡出，新字从它前面那个留下来的字旁边长出来
  function textTween(tl, ghost, next, d) {
    const num = numberParts(ghost.textContent, next.textContent);
    const from = offsetBox(ghost);
    const to = offsetBox(next);
    // 交接（藏起动画层、显出真元素）排在最后一帧之前：录制时最后一次 seek 落在
    // (帧数 - 1) / fps，排在正好 d 的话永远执行不到，真元素会留在隐藏状态。
    const hand = Math.max(0, d - 1 / 30);
    gsap.set(next, { autoAlpha: 0 });
    tl.set(next, { autoAlpha: 1 }, hand);
    tl.set(ghost, { autoAlpha: 0 }, hand);

    if ((next.hasAttribute("data-roll") || ghost.hasAttribute("data-roll")) && rollTween(tl, ghost, next, d)) return;

    if (num) {
      ghost.style.whiteSpace = "nowrap";
      const v = { n: num.from };
      tl.to(v, {
        n: num.to, duration: d, ease: "power2.inOut",
        onUpdate: () => { ghost.textContent = num.fmt(v.n); },
      }, 0);
      if (Math.hypot(from.x - to.x, from.y - to.y) > 1) {
        tl.to(ghost, { x: to.x - from.x, y: to.y - from.y, duration: d, ease: "power2.inOut" }, 0);
      }
      return;
    }

    const A = charize(ghost);
    const shadow = next.cloneNode(true);
    shadow.classList.add("st-ghost-el");
    shadow.style.visibility = "hidden";
    next.after(shadow);
    const B = charize(shadow);
    const pairs = matchChars(A.chars, B.chars);
    const sizeA = parseFloat(getComputedStyle(ghost).fontSize);
    const sizeB = parseFloat(getComputedStyle(next).fontSize);
    const colorB = getComputedStyle(next).color;
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    const movedA = new Set();
    const arrivedB = new Set();
    for (const [i, j] of pairs) {
      movedA.add(i);
      arrivedB.add(j);
      const a = A.spans[i];
      const b = B.spans[j];
      tl.to(a, {
        x: dx + b.offsetLeft - a.offsetLeft,
        y: dy + b.offsetTop - a.offsetTop,
        scale: sizeB / sizeA,
        color: colorB,
        transformOrigin: "0% 0%",
        duration: d * 0.6, ease: "power2.inOut",
      }, 0);
      tl.set(a, { autoAlpha: 0 }, hand);
    }
    const dropped = A.spans.filter((_, i) => !movedA.has(i));
    tl.to(dropped, { autoAlpha: 0, duration: d * 0.35, ease: "power1.in" }, 0);

    // 新字从左边最近的那个留下来的字旁边长出来；一个都没留下就整体淡入
    const anchorFor = (j) => {
      let best = null;
      for (const [, bj] of pairs) if (bj < j && (best === null || bj > best)) best = bj;
      if (best === null) for (const [, bj] of pairs) if (best === null || bj < best) best = bj;
      return best === null ? null : B.spans[best];
    };
    gsap.set(shadow, { visibility: "visible", autoAlpha: 1 });
    // 长出来的字按「跟着哪个留下来的字」分组（缩写展开时就是按词分组），同一组一起长，组间错开
    const grown = [];
    const groupOrder = new Map();
    B.spans.forEach((b, j) => {
      if (arrivedB.has(j)) { gsap.set(b, { autoAlpha: 0 }); return; }
      const anchor = anchorFor(j);
      const gk = anchor ? B.spans.indexOf(anchor) : -1;
      if (!groupOrder.has(gk)) groupOrder.set(gk, groupOrder.size);
      gsap.set(b, {
        autoAlpha: 0, transformOrigin: "0% 50%",
        x: anchor ? anchor.offsetLeft + anchor.offsetWidth - b.offsetLeft : 0,
        scaleX: 0.2,
      });
      grown.push([b, groupOrder.get(gk)]);
    });
    // 最后一组也要在 d 之前长完，字多时把错开量压缩，不让转场拖过总时长
    // 留下来的字先在 0.6d 落位，剩下的字再填进去，中途才不会出现「大字挤着小字」的错位
    const growAt = d * 0.5;
    const growD = d * 0.35;
    const step = Math.min(0.06, (d - growAt - growD) / Math.max(1, groupOrder.size - 1));
    for (const [b, order] of grown) {
      tl.to(b, { autoAlpha: 1, x: 0, scaleX: 1, duration: growD, ease: "power2.out" }, growAt + order * step);
    }
    tl.set(shadow, { autoAlpha: 0 }, hand);
  }

  // ───────── 翻面（data-flip，transitions.md「翻面」）─────────
  // 前后两页键相同的 data-flip 元素是同一张卡片：它从上一页的位置走到这一页的位置，大小、圆角一起变；
  // 内容不同时边走边翻 —— 横向压成一条线，侧面朝前的那一刻换成这一页的内容，再展开。
  // 换的那一刻宽度是 0，所以字永远不会镜像。PowerPoint 里「水平翻转 + 平滑」就是这么动的。
  // 内容相同时不翻，只走过去、变过去（整页的窗收成一格）。
  // data-flip-mode="fade"：不压扁，沿同一条路走，前半程淡出、后半程换成新内容淡入 —— 跟着卡片走的文字用它。
  // 卡片里写 data-fill="slide" 的图是「幻灯片背景填充」：按画布坐标铺满，卡片走到哪露出哪一块，
  // 引擎每帧把它往卡片走的反方向挪，画一直和画布对齐（prepareFills 把 <img> 换成 .s-fill）。
  const FLIP_D = 0.9;
  const FLIP_TEXT_OUT = 0.45;  // fade：前 45% 淡出，后 45% 淡入，中间空一小段
  const px = (n) => `${f1(n)}px`;
  const fillsOf = (el) => [...el.querySelectorAll(":scope > .s-fill")];
  function prepareFills(slides = allSlides()) {
    for (const img of within(slides, "img[data-fill]")) {
      const host = img.parentElement;
      const section = img.closest("section");
      if (img.dataset.fill !== "slide") {
        console.error(`[orca-transition-skill] data-fill 只认 "slide"（按画布坐标铺满），现在是「${img.dataset.fill}」`);
        continue;
      }
      if (host.parentElement !== section || !host.style.left || !host.style.top) {
        console.error("[orca-transition-skill] data-fill=\"slide\" 的图要放在页面直接子元素（窗）里，窗的 style 写 left / top（px）");
        continue;
      }
      // 换成背景图画的 <i>：reveal 会把前后两页 src 相同的 <img> 自动配成共享元素，给它加 transform 拉走
      const fill = document.createElement("i");
      fill.className = "s-fill";
      fill.style.backgroundImage = `url("${img.src}")`;
      fill.style.left = px(-parseFloat(host.style.left));
      fill.style.top = px(-parseFloat(host.style.top));
      img.replaceWith(fill);
    }
  }
  // 比较两张卡片的内容：图（含 .s-fill 的背景图）、字、类名
  const faceOf = (el) => [
    el.className, el.textContent.trim(),
    ...[...el.querySelectorAll("*")].map((n) => n.getAttribute("src") || n.style.backgroundImage || ""),
  ].join("|");
  function flipPairs(section, source) {
    const pairs = [];
    for (const el of section.querySelectorAll(":scope > [data-flip]")) {
      if (isRuntime(el)) continue;
      const key = el.dataset.flip;
      const old = source.querySelector(`:scope > [data-flip="${key}"]`);
      if (!old) continue;
      if (el.dataset.id || old.dataset.id) {
        console.error(`[orca-transition-skill] 翻面 data-flip="${key}" 不要同时写 data-id：两页内容不同，reveal 配成共享元素会和翻面抢着动`);
      }
      if (section.querySelectorAll(`[data-flip="${key}"]`).length > 1) {
        console.error(`[orca-transition-skill] 一页里只能有一个 data-flip="${key}"`);
      }
      pairs.push({ old, next: el });
    }
    return pairs;
  }
  function flipTween(tl, ghost, next, d) {
    const ease = "power2.inOut";
    const a = box(ghost);
    const b = box(next);
    if (next.dataset.flipMode === "fade") {
      const dx = b.left - a.left, dy = b.top - a.top;
      gsap.set(next, { autoAlpha: 0 });
      tl.fromTo(ghost, { x: 0, y: 0 }, { x: dx, y: dy, duration: d, ease }, 0);
      tl.fromTo(ghost, { autoAlpha: +getComputedStyle(ghost).opacity }, { autoAlpha: 0, duration: d * FLIP_TEXT_OUT, ease: "power1.in" }, 0);
      tl.fromTo(next, { x: -dx, y: -dy }, { x: 0, y: 0, duration: d, ease }, 0);
      tl.fromTo(next, { autoAlpha: 0 }, { autoAlpha: 1, duration: d * FLIP_TEXT_OUT, ease: "power1.out" }, d * (1 - FLIP_TEXT_OUT));
      return;
    }
    const turn = faceOf(ghost) !== faceOf(next);
    // 补间时直接改 left / top / width / height（不用 transform 缩放）：卡片里的画要按画布坐标反着挪，
    // 缩放会把画也缩了。走完把这一页元素的样式原样还回去
    const saved = [next, ...fillsOf(next)].map((el) => [el, el.style.cssText]);
    const state = { e: 0 };
    const at = (k) => a[k] + (b[k] - a[k]) * state.e;
    const draw = () => {
      if (state.e >= 1) {
        for (const [el, css] of saved) el.style.cssText = css;
        ghost.style.visibility = "hidden";
        return;
      }
      const L = at("left"), T = at("top");
      for (const el of [ghost, next]) {
        Object.assign(el.style, {
          left: px(L), top: px(T), width: px(at("width")), height: px(at("height")),
          borderRadius: px(at("borderRadius")),
          transform: turn ? `scaleX(${Math.abs(Math.cos(Math.PI * state.e)).toFixed(4)})` : "",
        });
        for (const f of fillsOf(el)) Object.assign(f.style, { left: px(-L), top: px(-T) });
      }
      const shown = !turn || state.e >= 0.5;
      ghost.style.visibility = shown ? "hidden" : "";
      next.style.visibility = shown ? "" : "hidden";
    };
    draw();
    tl.to(state, { e: 1, duration: d, ease, onUpdate: draw }, 0);
  }

  // 找出两页里键相同的 data-swap / data-text 元素对
  function elementPairs(section, source) {
    const pairs = [];
    for (const attr of ["swap", "text"]) {
      for (const el of section.querySelectorAll(`[data-${attr}]`)) {
        const key = el.dataset[attr];
        const old = source.querySelector(`[data-${attr}="${key}"]`);
        const name = attr === "swap" ? "原地替换" : "文字级匹配";
        // 上一页没有同名元素 = 这个元素第一次出现，按普通新元素入场，不算错
        if (!old) continue;
        if (el.parentElement !== section || old.parentElement !== source) {
          console.error(`[orca-transition-skill] ${name} data-${attr}="${key}" 必须写在页面的直接子元素上`);
          continue;
        }
        if (el.dataset.id) {
          console.error(`[orca-transition-skill] ${name} data-${attr}="${key}" 不要同时写 data-id，内容不同配不成共享元素`);
        }
        if (attr === "text" && (el.children.length || old.children.length)) {
          console.error(`[orca-transition-skill] 文字级匹配 data-text="${key}" 只能写在纯文字元素上`);
          continue;
        }
        // 前后内容一模一样 = 这个元素本来就该原地不动，不要当成一次替换
        const same = attr === "text"
          ? old.textContent.trim() === el.textContent.trim()
          : old.getAttribute("src") === el.getAttribute("src") && old.className === el.className
            && old.textContent.trim() === el.textContent.trim();
        if (same) continue;
        const a = offsetBox(old);
        const b = offsetBox(el);
        const off = attr === "swap"
          ? Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2)
          : Math.hypot(a.x - b.x, a.y - b.y);
        if (off > PAIR_TOL) {
          console.warn(`[orca-transition-skill] ${name} data-${attr}="${key}" 前后两页相差 ${Math.round(off)}px，这个手法是「原地」换内容，位置要对齐`);
        }
        const ratio = (x, y) => Math.max(x, y) / Math.max(1, Math.min(x, y));
        if (attr === "swap" && Math.max(ratio(a.w, b.w), ratio(a.h, b.h)) > SWAP_SIZE_RATIO) {
          console.warn(`[orca-transition-skill] 原地替换 data-swap="${key}" 前后两页尺寸差了 ${SWAP_SIZE_RATIO} 倍以上（${a.w}×${a.h} → ${b.w}×${b.h}），交叉溶解会看成两个东西叠着，不是一个变成另一个`);
        }
        pairs.push({ attr, old, next: el });
      }
    }
    return pairs;
  }
  // auto-animate 页的补充：reveal 会让上一页没配对的元素瞬间消失，新页没配对的元素只会淡入。
  // 这里把旧元素克隆出来淡出，新元素按 data-auto-animate-delay 上浮淡入。
  function autoAnimateExtras(section, prev) {
    // 「配上了」= 两页都有同一个 data-id。只有一边有的也算没配对
    const ids = (sec) => new Set([...sec.querySelectorAll("[data-id]")].map((el) => el.dataset.id));
    const prevIds = ids(prev);
    const currIds = ids(section);
    // reveal 配对要求标签名也相同，不同就静默失败，这里报出来
    for (const el of section.querySelectorAll("[data-id]")) {
      const twin = prev.querySelector(`[data-id="${el.dataset.id}"]`);
      if (twin && twin.tagName !== el.tagName) {
        console.error(`[orca-transition-skill] data-id="${el.dataset.id}" 前一页是 <${twin.tagName.toLowerCase()}>，这一页是 <${el.tagName.toLowerCase()}>，标签不同配不上`);
      }
    }
    // 前后两页一模一样的元素（页眉、页脚）原地不动：不克隆出来淡出，新页的也不重新入场
    const source = contentOf(prev);
    const sameIn = (parent) => new Set([...parent.children].filter((el) => !el.dataset.id).map(signature));
    const prevSame = sameIn(source);
    const currSame = sameIn(section);
    // 元素级的原地替换 / 文字级匹配：旧元素照常克隆出来，但不跟着淡出，交给下面的 swapTween / textTween
    const pairs = elementPairs(section, source);
    // 翻面也一样：旧卡片克隆出来，交给 flipTween
    const flips = flipPairs(section, source);
    const pairedOld = new Set([...pairs, ...flips].map((p) => p.old));
    const pairedNew = new Set([...pairs, ...flips].map((p) => p.next));
    const ghostOf = new Map();

    // 旧页没配对的元素克隆出来淡出。克隆不整层放在最上面或最下面，而是按旧页里的上下关系插进新页：
    // 插在「旧页里排在它前面、最近的那个配对元素」在新页里的孪生元素后面。
    // 这样圆里的字仍在长大的圆上面，而垫在底下的大面板淡出时不会盖住它上面的共享元素。
    const ghosts = [];
    let cursor = null;
    for (const child of source.children) {
      if (isRuntime(child)) continue;
      const id = child.dataset.id;
      if (id && currIds.has(id)) {
        cursor = section.querySelector(`:scope > [data-id="${id}"]`) ?? cursor;
        continue;
      }
      if (!id && !pairedOld.has(child) && currSame.has(signature(child))) continue;
      const clone = ghostClone(child);
      clone.classList.add("st-ghost-el");
      if (cursor) cursor.after(clone);
      else section.prepend(clone);
      cursor = clone;
      if (pairedOld.has(child)) ghostOf.set(child, clone);
      else ghosts.push(clone);
    }
    // 替换对、翻面对的旧元素压在新元素正下方，交叉溶解时层次才对
    for (const p of [...pairs, ...flips]) {
      const g = ghostOf.get(p.old);
      if (g) p.next.before(g);
    }
    const tl = timeline();
    // 从元素自己的透明度淡出：本来就透明（opacity:0 待命）的元素不能先被设成不透明再淡出，那会闪一下
    const keepGhosts = keepRotate(ghosts);
    tl.fromTo(ghosts, { autoAlpha: (_, el) => +getComputedStyle(el).opacity, y: 0 }, { autoAlpha: 0, y: -16, duration: 0.35, ease: "power1.in", onUpdate: keepGhosts }, 0);
    // 写了页内动画的元素（或里面包着它们的组）入场归页内动画管：这里再让它上浮淡入，
    // 转场一结束它就已经看得见了，点击分步的「点一下才出来」就没了
    const BUILD = "[data-anim], [data-path], [data-lit], [data-step]";
    const incoming = [...section.children].filter((el) =>
      !prevIds.has(el.dataset.id) && !el.matches(".st-layer, .st-ghost-el") && !pairedNew.has(el)
      && !(!el.dataset.id && prevSame.has(signature(el)))
      && !el.matches(BUILD) && !el.querySelector(BUILD));
    for (const el of incoming) enterTween(tl, el, +(el.dataset.autoAnimateDelay ?? 0.6));
    // 共享元素的裁剪形状跟着位置一起变：时长、延迟、缓动和 reveal 挪位置的那一下对齐
    for (const el of section.querySelectorAll(":scope > [data-id]")) {
      const twin = source.querySelector(`:scope > [data-id="${CSS.escape(el.dataset.id)}"]`);
      if (!twin || el.matches(BUILD) || !el.style.clipPath || !twin.style.clipPath) continue;
      const to = AUTHORED_CLIP.get(el) ?? el.style.clipPath;
      const from = AUTHORED_CLIP.get(twin) ?? twin.style.clipPath;
      AUTHORED_CLIP.set(el, to);
      AUTHORED_CLIP.set(twin, from);
      if (from === to) continue;
      const d = +(el.dataset.autoAnimateDuration ?? section.dataset.autoAnimateDuration ?? Reveal.getConfig().autoAnimateDuration);
      clipTween(tl, el, from, to, d, +(el.dataset.autoAnimateDelay ?? 0));
    }
    for (const p of pairs) {
      const g = ghostOf.get(p.old);
      if (!g) continue;
      const d = +p.next.dataset.duration
        || (p.attr === "swap" ? SWAP_D : p.next.hasAttribute("data-roll") ? ROLL_D : TEXT_D);
      (p.attr === "swap" ? swapTween : textTween)(tl, g, p.next, d);
    }
    for (const p of flips) {
      const g = ghostOf.get(p.old);
      if (g) flipTween(tl, g, p.next, +p.next.dataset.duration || FLIP_D);
    }
    lampTweens(tl, section, source);
    return tl;
  }

  // 形状元素的位置、尺寸、底色、圆角（圆角换算成像素，不超过短边一半），一变多 / 多合一用来插值
  const radiusPx = (cs, w, h) => {
    const r = cs.borderTopLeftRadius;
    return r.endsWith("%") ? (parseFloat(r) / 100) * Math.min(w, h) : parseFloat(r) || 0;
  };
  const box = (el) => {
    const cs = getComputedStyle(el);
    return {
      left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight,
      backgroundColor: cs.backgroundColor,
      borderRadius: Math.min(radiusPx(cs, el.offsetWidth, el.offsetHeight), Math.min(el.offsetWidth, el.offsetHeight) / 2),
    };
  };

  // 一变多：上一页一个元素，下一页多个元素写同一个 data-split。
  // 第一帧，多个新元素叠在旧元素的位置、用旧元素的颜色和圆角，看起来还是那一个；
  // 然后依次散开，飞到各自的位置，变成各自的尺寸、颜色、圆角。
  builders.split = (section, ghost, enter) => {
    const key = section.dataset.stSplit;
    const sel = `[data-split="${key}"]`;
    const src = ghost.querySelector(sel);
    const targets = [...enter.querySelectorAll(sel)];
    if (!src || targets.length < 2) {
      console.error(`[orca-transition-skill] split 需要上一页有一个 ${sel}，这一页至少两个（现在是 ${src ? 1 : 0} 和 ${targets.length}）`);
      return timeline();
    }
    const d = +section.dataset.stDuration || 1.2;
    const move = d * 0.75;
    const stagger = Math.min(0.08, (d - move) / targets.length);
    const from = box(src);
    const ends = targets.map(box);

    const newSigs = new Set([...enter.children].map(signature));
    const oldSigs = new Set([...ghost.children].map(signature));
    const oldRest = [...ghost.children].filter((el) => el !== src && !newSigs.has(signature(el)));
    const sameOld = [...ghost.children].filter((el) => el !== src && newSigs.has(signature(el)));
    const newRest = [...enter.children].filter((el) => !targets.includes(el) && !oldSigs.has(signature(el)));
    const sameNew = [...enter.children].filter((el) => !targets.includes(el) && oldSigs.has(signature(el)));

    // 目标卡片一开始叠在源元素的位置，而且在 enter 层（ghost 层之上）。
    // 旧页里叠在源元素上面的内容（圆里的字、面板上的柱子）挪到 enter 之上的一层，否则第一帧就被卡片盖掉
    const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    const srcRect = rectOf(src);
    const above = [...ghost.children].slice([...ghost.children].indexOf(src) + 1)
      .filter((el) => oldRest.includes(el) && overlaps(rectOf(el), srcRect));
    if (above.length) {
      const top = layer("st-ghost");
      top.append(...above);
      section.append(top);
    }

    gsap.set(src, { autoAlpha: 0 });
    if (sameNew.length) gsap.set(sameNew, { autoAlpha: 0 });
    for (const el of targets) gsap.set(el, { ...from, borderRadius: `${from.borderRadius}px` });

    const tl = timeline();
    tl.to(oldRest, { autoAlpha: 0, y: -16, duration: 0.35, ease: "power1.in" }, 0);
    targets.forEach((el, i) => {
      const end = ends[i];
      tl.to(el, { ...end, borderRadius: `${end.borderRadius}px`, duration: move, ease: "power2.inOut" }, i * stagger);
    });
    const restAt = move * 0.7;
    newRest.forEach((el, i) => enterTween(tl, el, +(el.dataset.enterDelay ?? restAt + i * 0.04)));
    tl.set(sameNew, { autoAlpha: 1 }, d);
    tl.set(sameOld, { autoAlpha: 0 }, d);
    return tl;
  };

  // 多合一：一变多反过来。上一页多个元素、这一页一个元素写同一个 data-merge。
  // 上一页的几个形状（ghost 里的克隆）依次飞到新元素的位置，变成它的尺寸、颜色、圆角，叠成一个；
  // 最后一个落位时换成真正的新元素。其他新元素在合拢后期入场。
  builders.merge = (section, ghost, enter) => {
    const key = section.dataset.stMerge;
    const sel = `[data-merge="${key}"]`;
    const srcs = [...ghost.querySelectorAll(sel)];
    const target = enter.querySelector(sel);
    if (srcs.length < 2 || !target || enter.querySelectorAll(sel).length > 1) {
      console.error(`[orca-transition-skill] merge 需要上一页至少两个 ${sel}，这一页恰好一个（现在是 ${srcs.length} 和 ${enter.querySelectorAll(sel).length}）`);
      return timeline();
    }
    const d = +section.dataset.stDuration || 1.2;
    const move = d * 0.75;
    const stagger = Math.min(0.08, (d - move) / srcs.length);
    const to = box(target);
    const landed = (srcs.length - 1) * stagger + move;

    const newSigs = new Set([...enter.children].map(signature));
    const oldSigs = new Set([...ghost.children].map(signature));
    const oldRest = [...ghost.children].filter((el) => !srcs.includes(el) && !newSigs.has(signature(el)));
    const sameOld = [...ghost.children].filter((el) => !srcs.includes(el) && newSigs.has(signature(el)));
    const newRest = [...enter.children].filter((el) => el !== target && !oldSigs.has(signature(el)));
    const sameNew = [...enter.children].filter((el) => el !== target && oldSigs.has(signature(el)));

    gsap.set(target, { autoAlpha: 0 });
    if (sameNew.length) gsap.set(sameNew, { autoAlpha: 0 });

    const tl = timeline();
    tl.to(oldRest, { autoAlpha: 0, y: -16, duration: 0.35, ease: "power1.in" }, 0);
    srcs.forEach((el, i) => {
      tl.to(el, { ...to, borderRadius: `${to.borderRadius}px`, duration: move, ease: "power2.inOut" }, i * stagger);
    });
    tl.set(target, { autoAlpha: 1 }, landed);
    tl.set(srcs, { autoAlpha: 0 }, landed);
    const restAt = landed * 0.8;
    newRest.forEach((el, i) => enterTween(tl, el, +(el.dataset.enterDelay ?? restAt + i * 0.04)));
    tl.set(sameNew, { autoAlpha: 1 }, Math.max(d, landed));
    tl.set(sameOld, { autoAlpha: 0 }, Math.max(d, landed));
    return tl;
  };

  // ───────── 吊灯（.s-lamp，transitions.md「吊灯」）─────────
  // <div class="s-lamp" data-id="lamp" data-lamp="x y len angle on reach pool">
  //   <img src="art/lamp.webp" alt="" style="width:320px; height:210px;" data-mouth="0.81">
  // </div>
  //   x y    吊点（天花板上的那一点，通常在画布顶上方）
  //   len    吊线长：吊点到灯顶
  //   angle  整盏灯绕吊点转多少度。0 朝下，正数往左照，负数往右照
  //   on     0–1，开灯程度：灯的亮度、光束、光圈、被照亮那一层的亮度
  //   reach  光圈离罩口多远（沿灯轴，px），可省略，默认 520
  //   pool   照亮的范围（半径，px），可省略，默认按光束在光圈处的宽度算
  // 灯是一张透明底的实物图，引擎把它挂在吊线下面整体绕吊点转 —— 吊灯就是这么动的。
  // data-mouth 是罩口在图里的高度比例（0–1），光束从那里打出去。
  // 光束、光圈画在灯后面；同页的 .s-lit 是「被照亮的那一层」：光圈里看得见，光圈外只剩一点余光。
  // 共享元素页里前后两页同一个 data-id 的灯：参数在转场时间线里补间，每帧重画。
  // 灯写 data-lamp-via="dark" 时，先关灯、黑着挪过去、再开灯（换场景用）。
  // 灯写 data-lamp-on="秒" 时，进页先关着，过这么久自己亮起来（开场用，见 lampIntro）。
  const LAMP = { reach: 520, spread: 0.42, blur: 24, ambient: 0.07, offBright: 0.3 };
  const LAMP_KEYS = ["x", "y", "len", "angle", "on", "reach", "pool"];
  function lampPose(el) {
    const v = (el.dataset.lamp || "").trim().split(/\s+/).map(Number);
    if (v.length === 5) v.push(LAMP.reach);
    if (v.length === 6) v.push(0);
    if (v.length !== 7 || v.some((n) => !Number.isFinite(n))) {
      console.error(`[orca-transition-skill] .s-lamp 的 data-lamp 要写「x y len angle on」五个数，可再加 reach、pool，现在是「${el.dataset.lamp ?? ""}」`);
      return null;
    }
    const p = Object.fromEntries(LAMP_KEYS.map((k, i) => [k, v[i]]));
    p.angle = ranged(".s-lamp", "angle", p.angle, -75, 75);
    p.on = ranged(".s-lamp", "on", p.on, 0, 1);
    p.reach = ranged(".s-lamp", "reach", p.reach, 120, 1600);
    return p;
  }
  let lampSeq = 0;
  function buildLamp(host) {
    const img = host.querySelector(":scope > img");
    if (!img) {
      console.error("[orca-transition-skill] .s-lamp 里要放一张灯的图：<img src=\"…\" style=\"width:…; height:…;\" data-mouth=\"0.8\">");
      return false;
    }
    const w = parseFloat(img.style.width), h = parseFloat(img.style.height);
    if (!(w > 0 && h > 0)) {
      console.error("[orca-transition-skill] .s-lamp 里的灯图要在 style 里写 width 和 height（px）");
      return false;
    }
    const id = ++lampSeq;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "lamp-light");
    svg.innerHTML = `<defs>
        <linearGradient id="lamp-beam-${id}" gradientUnits="userSpaceOnUse"><stop offset="0" class="lamp-beam-0"/><stop offset="1" class="lamp-beam-1"/></linearGradient>
        <radialGradient id="lamp-halo-${id}"><stop offset="0" class="lamp-halo-0"/><stop offset="0.6" class="lamp-halo-1"/><stop offset="1" class="lamp-halo-2"/></radialGradient>
        <filter id="lamp-soft-${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${LAMP.blur}"/></filter>
      </defs>
      <ellipse fill="url(#lamp-halo-${id})"/>
      <path fill="url(#lamp-beam-${id})" filter="url(#lamp-soft-${id})"/>`;
    const rig = document.createElement("div");
    rig.className = "lamp-rig";
    const cord = document.createElement("i");
    cord.className = "lamp-cord";
    // 灯图换成背景图画的 div：reveal 会把前后两页 src 相同的 <img> 自动配成共享元素，
    // 翻页时给它加 transform: none !important，盖掉这里给灯定的位置，灯就脱离吊线
    const body = document.createElement("i");
    body.className = "lamp-body";
    body.style.width = `${w}px`;
    body.style.height = `${h}px`;
    body.style.backgroundImage = `url("${img.src}")`;
    rig.append(cord, body);
    host.replaceChildren(svg, rig);
    host._lamp = {
      w, h, mouth: +(img.dataset.mouth ?? 0.8), svg, rig, cord, img: body,
      halo: svg.querySelector("ellipse"), beam: svg.querySelector("path"),
      beamGrad: svg.querySelector(`#lamp-beam-${id}`),
      lit: [...contentOf(host.closest("section")).querySelectorAll(":scope > .s-lit")],
    };
    return true;
  }
  const f1 = (n) => n.toFixed(1);
  // 没写 pool 时照亮的半径：光圈半径再放大一点，光圈边上的东西也读得清
  const autoPool = (host, { reach }) => (host._lamp.w * 0.42 + reach * LAMP.spread) * 1.2 * 1.35;
  function drawLamp(host, { x, y, len, angle, on, reach, pool }) {
    const P = host._lamp;
    const a = (angle * Math.PI) / 180;
    // 绕吊点顺时针转 angle：朝下的灯轴 (0, 1) 转成 (-sin, cos)
    const dir = [-Math.sin(a), Math.cos(a)];
    const across = [-dir[1], dir[0]];
    P.rig.style.transform = `translate(${f1(x)}px, ${f1(y)}px) rotate(${angle.toFixed(2)}deg)`;
    P.cord.style.height = `${f1(len)}px`;
    P.img.style.transform = `translate(${f1(-P.w / 2)}px, ${f1(len)}px)`;
    P.img.style.filter = `brightness(${(LAMP.offBright + (1 - LAMP.offBright) * on).toFixed(3)})`;
    const d0 = len + P.h * P.mouth;
    const m = [x + dir[0] * d0, y + dir[1] * d0];
    // 光束和罩口一样宽，从罩口里面一截开始：模糊会把光束起点淡掉，淡掉的那段藏在灯图后面，
    // 露出来的部分从罩口边上就是亮的，罩口和光束之间不留暗缝
    const back = LAMP.blur * 2;
    const s = [m[0] - dir[0] * back, m[1] - dir[1] * back];
    const w0 = P.w * 0.47, w1 = w0 + reach * 1.8 * LAMP.spread;
    const far = [m[0] + dir[0] * reach * 1.8, m[1] + dir[1] * reach * 1.8];
    const pt = (q) => `${f1(q[0])} ${f1(q[1])}`;
    P.beam.setAttribute("d", `M${pt([s[0] + across[0] * w0, s[1] + across[1] * w0])}L${pt([far[0] + across[0] * w1, far[1] + across[1] * w1])}L${pt([far[0] - across[0] * w1, far[1] - across[1] * w1])}L${pt([s[0] - across[0] * w0, s[1] - across[1] * w0])}Z`);
    for (const [k, v] of Object.entries({ x1: s[0], y1: s[1], x2: far[0], y2: far[1] })) P.beamGrad.setAttribute(k, f1(v));
    const c = [m[0] + dir[0] * reach, m[1] + dir[1] * reach];
    const hr = (w0 + reach * LAMP.spread) * 1.2;
    for (const [k, v] of Object.entries({ cx: c[0], cy: c[1], rx: hr, ry: hr * 0.9 })) P.halo.setAttribute(k, f1(v));
    P.svg.style.opacity = on.toFixed(3);
    // 被照亮的那一层：光圈里亮，往外渐暗到余光。没开灯时整层只剩余光
    const r = pool > 0 ? pool : autoPool(host, { reach });
    const inner = (LAMP.ambient + (1 - LAMP.ambient) * on).toFixed(3);
    const mask = `radial-gradient(ellipse ${f1(r)}px ${f1(r * 0.9)}px at ${f1(c[0])}px ${f1(c[1])}px, rgb(0 0 0 / ${inner}) 0%, rgb(0 0 0 / ${inner}) 50%, rgb(0 0 0 / ${LAMP.ambient}) 100%)`;
    for (const el of P.lit) {
      el.style.webkitMaskImage = mask;
      el.style.maskImage = mask;
    }
  }
  function prepareLamps(slides = allSlides()) {
    for (const host of within(slides, ".s-lamp")) {
      const section = host.closest("section");
      if (host.parentElement !== contentOf(section)) console.warn("[orca-transition-skill] .s-lamp 要写在页面的直接子元素上，灯按画布坐标画");
      if (section.querySelectorAll(".s-lamp").length > 1) console.warn("[orca-transition-skill] 一页只放一盏 .s-lamp：被照亮的那一层（.s-lit）只认一盏灯");
      const pose = lampPose(host);
      if (!pose || !buildLamp(host)) continue;
      host._pose = pose;
      drawLamp(host, pose);
    }
    for (const lit of within(slides, ".s-lit")) {
      if (!lit.closest("section").querySelector(".s-lamp")) console.warn("[orca-transition-skill] .s-lit 所在的页没有 .s-lamp，这一层会一直是黑的");
    }
  }
  // 进页开灯：灯写 data-lamp-on="秒" 时，进这一页时灯是关着的，过这么久自己亮起来（页内动画，不占一页）。
  // 只写在开场那一页：从上一页的灯转场过来时，转场会把灯直接补间到亮着的样子
  const LAMP_ON_S = 0.8;
  function lampIntro(slide) {
    const host = contentOf(slide).querySelector(":scope > .s-lamp[data-lamp-on]");
    if (!host?._pose) return null;
    const delay = Math.max(0, +host.dataset.lampOn || 0);
    const state = { ...host._pose, on: 0 };
    drawLamp(host, state);
    const tl = gsap.timeline({ paused: true });
    tl.to(state, { on: host._pose.on, duration: LAMP_ON_S, ease: "power2.out", onUpdate: () => drawLamp(host, state) }, delay);
    tl.data = { stops: [delay + LAMP_ON_S] };
    return tl;
  }
  // 共享元素页：同 data-id 的灯，参数从上一页补间到这一页，和 reveal 的 auto-animate 同时长、同曲线
  function lampTweens(tl, section, source) {
    const d = +section.dataset.autoAnimateDuration || 0.9;
    for (const host of section.querySelectorAll(":scope > .s-lamp[data-id]")) {
      const prev = source.querySelector(`:scope > .s-lamp[data-id="${host.dataset.id}"]`);
      if (!prev?._pose || !host._pose) continue;
      const from = { ...prev._pose }, to = { ...host._pose };
      // 只有一边写了 pool 时，另一边换成按光束算出来的值，免得补间从 0 起跳
      if (!from.pool !== !to.pool) {
        if (!from.pool) from.pool = autoPool(prev, from);
        else to.pool = autoPool(host, to);
      }
      const state = { ...from };
      const draw = () => drawLamp(host, state);
      if (host.dataset.lampVia === "dark") {
        // 关灯 → 黑着挪过去 → 开灯
        const pose = Object.fromEntries(LAMP_KEYS.filter((k) => k !== "on").map((k) => [k, to[k]]));
        tl.fromTo(state, { ...from }, { on: 0, duration: d * 0.35, ease: "power2.in", onUpdate: draw }, 0);
        tl.to(state, { ...pose, duration: d * 0.4, ease: "power2.inOut", onUpdate: draw }, d * 0.3);
        tl.to(state, { on: to.on, duration: d * 0.35, ease: "power2.out", onUpdate: draw }, d * 0.65);
      } else {
        tl.fromTo(state, { ...from }, { ...to, duration: d, ease: "power2.inOut", onUpdate: draw }, 0);
      }
    }
  }

  // ───────── 故事模式 ─────────
  // 照片 <img class="st-photo" width height data-anchors="名字:…; 名字:…">，坐标是原图像素：
  //   圆      名字:cx,cy,r
  //   矩形    名字:x,y,w,h
  //   四边形  名字:q:x1,y1,x2,y2,x3,y3,x4,y4   （四个角，顺时针或逆时针都行；斜的屏幕、透视下的卡片用它）
  // 照片默认铺满画布（cover）。「镜头」= 原图上的哪个点对准画布中心 + 缩放倍数。
  // 页面写 data-guide="锚点名" 时，引导框常驻在这个锚点上，转场时跟着锚点走。
  // 引导框是 SVG 画的一圈点（GUIDE_POINTS 个），所有形状都用同一种表示，圆变四边形时逐点插值。
  const MATCH_R = 300;      // 匹配时锚点在画面上的半径
  const GUIDE_PAD = 16;     // 引导框比锚点大一圈
  const GUIDE_POINTS = 96;
  const MIN_ANCHOR = 40;    // 锚点半径（矩形、四边形取外接框长边的一半）小于它，推近后会糊
  const err = (msg) => console.error(`[orca-transition-skill] ${msg}`);
  const warn = (msg) => console.warn(`[orca-transition-skill] ${msg}`);

  function parseAnchors(img) {
    if (img._anchors) return img._anchors;
    const out = {};
    const src = img.getAttribute("src");
    for (const raw of (img.dataset.anchors || "").split(";")) {
      const item = raw.trim();
      if (!item) continue;
      const i = item.indexOf(":");
      if (i < 0) { err(`照片 ${src} 的锚点「${item}」缺少冒号，格式是 名字:数字,数字…`); continue; }
      const name = item.slice(0, i).trim();
      let body = item.slice(i + 1).trim();
      const quad = body.startsWith("q:");
      if (quad) body = body.slice(2);
      const v = body.split(",").map((x) => Number(x.trim()));
      if (v.some((x) => Number.isNaN(x))) { err(`照片 ${src} 的锚点「${name}」里有不是数字的值：${body}`); continue; }
      let a;
      if (quad) {
        if (v.length !== 8) { err(`照片 ${src} 的四边形锚点「${name}」要 8 个数字（四个角），现在是 ${v.length} 个`); continue; }
        a = { kind: "poly", pts: [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]], [v[6], v[7]]] };
      } else if (v.length === 3) {
        a = { kind: "circle", cx: v[0], cy: v[1], r: v[2], size: v[2] };
      } else if (v.length === 4) {
        a = { kind: "poly", pts: [[v[0], v[1]], [v[0] + v[2], v[1]], [v[0] + v[2], v[1] + v[3]], [v[0], v[1] + v[3]]] };
      } else {
        err(`照片 ${src} 的锚点「${name}」有 ${v.length} 个数字：圆写 3 个，矩形写 4 个，四边形写 q: 加 8 个`);
        continue;
      }
      if (a.kind === "poly") {
        const xs = a.pts.map((p) => p[0]);
        const ys = a.pts.map((p) => p[1]);
        a.cx = xs.reduce((s, x) => s + x, 0) / 4;
        a.cy = ys.reduce((s, y) => s + y, 0) / 4;
        a.size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
      }
      a.name = name;
      out[name] = a;
    }
    img._anchors = out;
    return out;
  }
  const anchorOf = (img, name) => {
    const a = parseAnchors(img)[name];
    if (!a) err(`照片 ${img.getAttribute("src")} 上没有锚点「${name}」`);
    return a;
  };
  const restCam = (img) => {
    const w = +img.getAttribute("width");
    const h = +img.getAttribute("height");
    return { k: Math.max(W / w, H / h), cx: w / 2, cy: h / 2 };
  };
  const MAX_PUSH = 3;     // 相对原位最多推近几倍，再大照片会糊
  const MIN_PUSH = 1.3;   // 少于这个倍数，观众看不出在推近
  const sizeOf = (a) => a.size;
  const imgSize = (img) => [+img.getAttribute("width"), +img.getAttribute("height")];

  // 推近匹配的切点帧：两张照片的锚点要落在画面上同一点、同样大小，而且两张照片都得铺满画布。
  // 先按 MAX_PUSH 定半径，再在两张照片「不露边」的可行区间里，找离画面中心最近的落点。
  function planMatch(imgA, a, imgB, b) {
    const restA = restCam(imgA).k;
    const restB = restCam(imgB).k;
    let R = Math.min(MATCH_R, MAX_PUSH * restA * sizeOf(a), MAX_PUSH * restB * sizeOf(b));
    const feasible = (img, anc, k) => {
      const [w, h] = imgSize(img);
      // 锚点在画面 (px, py)：照片左边缘 px - cx·k ≤ 0，右边缘 px + (w - cx)·k ≥ W，上下同理
      return { x0: W - (w - anc.cx) * k, x1: anc.cx * k, y0: H - (h - anc.cy) * k, y1: anc.cy * k };
    };
    for (let tries = 0; tries < 6; tries++) {
      const fa = feasible(imgA, a, R / sizeOf(a));
      const fb = feasible(imgB, b, R / sizeOf(b));
      const x0 = Math.max(fa.x0, fb.x0), x1 = Math.min(fa.x1, fb.x1);
      const y0 = Math.max(fa.y0, fb.y0), y1 = Math.min(fa.y1, fb.y1);
      if (x0 <= x1 && y0 <= y1) {
        const px = Math.min(Math.max(W / 2, x0), x1);
        const py = Math.min(Math.max(H / 2, y0), y1);
        const pushA = R / sizeOf(a) / restA;
        const pushB = R / sizeOf(b) / restB;
        if (Math.min(pushA, pushB) < MIN_PUSH - 0.005) {
          const weak = pushA < pushB ? a : b;
          const other = weak === a ? b : a;
          const cause = R < MATCH_R - 0.5 && sizeOf(other) < sizeOf(weak)
            ? `另一个锚点「${other.name}」太小，推近上限 ${MAX_PUSH} 倍把切点半径压低了`
            : `锚点「${weak.name}」在照片里太大`;
          warn(`zoom-match 推近不够：「${a.name}」${pushA.toFixed(2)} 倍，「${b.name}」${pushB.toFixed(2)} 倍，低于 ${MIN_PUSH} 看起来像平移。原因：${cause}`);
        }
        return { R, px, py };
      }
      R *= 1.2; // 推得越近，可行区间越宽
    }
    warn(`zoom-match「${a.name}」和「${b.name}」在各自照片里的位置差太多，推近后会露出照片边缘。换锚点或换照片顺序`);
    return { R, px: W / 2, py: H / 2 };
  }
  const focusCam = (a, plan) => {
    const k = plan.R / sizeOf(a);
    return { k, cx: a.cx - (plan.px - W / 2) / k, cy: a.cy - (plan.py - H / 2) / k };
  };
  // 过渡中的镜头也不许露边：把中心点夹在照片能铺满画布的范围里
  const clampCam = (img, cam) => {
    const [w, h] = imgSize(img);
    const hx = W / 2 / cam.k, hy = H / 2 / cam.k;
    return { k: cam.k, cx: Math.min(Math.max(cam.cx, hx), w - hx), cy: Math.min(Math.max(cam.cy, hy), h - hy) };
  };
  // 缩放按对数插值，推近的速度感才均匀
  const mixCam = (a, b, t) => ({
    k: Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * t),
    cx: a.cx + (b.cx - a.cx) * t,
    cy: a.cy + (b.cy - a.cy) * t,
  });
  const applyCam = (img, cam) =>
    gsap.set(img, { x: W / 2 - cam.cx * cam.k, y: H / 2 - cam.cy * cam.k, scale: cam.k, transformOrigin: "0 0" });
  const toScreen = (cam, x, y) => [W / 2 + (x - cam.cx) * cam.k, H / 2 + (y - cam.cy) * cam.k];

  // ── 引导框的点
  // 所有形状都按「从中心每隔同样角度发一条射线，取射线和轮廓的交点」取点，起点在正上方，顺时针。
  // 这样圆和方的第 n 个点在同一个方向上，逐点插值时形状对称地收放，不会被拧歪。
  // 锚点都是凸形状（圆、矩形、四边形），每条射线和轮廓只有一个交点。
  function resample(poly, cx, cy) {
    const out = [];
    for (let n = 0; n < GUIDE_POINTS; n++) {
      const a = -Math.PI / 2 + (n / GUIDE_POINTS) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      let best = null;
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        const ex = x2 - x1, ey = y2 - y1;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((x1 - cx) * ey - (y1 - cy) * ex) / den; // 射线上的距离
        const u = ((x1 - cx) * dy - (y1 - cy) * dx) / den; // 边上的位置 0..1
        if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6 && (best === null || t > best)) best = t;
      }
      out.push(best === null ? [cx, cy] : [cx + dx * best, cy + dy * best]);
    }
    return out;
  }
  function circlePoints(cx, cy, r) {
    return Array.from({ length: GUIDE_POINTS }, (_, n) => {
      const a = -Math.PI / 2 + (n / GUIDE_POINTS) * Math.PI * 2;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
  }
  // 锚点在当前镜头下的引导框：圆直接取点；多边形往外扩一圈，再把角修圆
  // 多边形锚点在屏幕上的四个角（已往外扩），统一从左上角起、顺时针排，两个四边形才能逐角混合
  function screenCorners(cam, a) {
    const [cx, cy] = toScreen(cam, a.cx, a.cy);
    let corners = a.pts.map(([x, y]) => {
      const [sx, sy] = toScreen(cam, x, y);
      const d = Math.hypot(sx - cx, sy - cy) || 1;
      return [sx + ((sx - cx) / d) * GUIDE_PAD * 1.4, sy + ((sy - cy) / d) * GUIDE_PAD * 1.4];
    });
    let area = 0;
    corners.forEach(([x1, y1], i) => { const [x2, y2] = corners[(i + 1) % 4]; area += x1 * y2 - x2 * y1; });
    if (area < 0) corners = corners.reverse();
    let start = 0;
    corners.forEach(([x, y], i) => { if (x + y < corners[start][0] + corners[start][1]) start = i; });
    return [...corners.slice(start), ...corners.slice(0, start)];
  }
  function outline(cam, a) {
    const [cx, cy] = toScreen(cam, a.cx, a.cy);
    if (a.kind === "circle") return circlePoints(cx, cy, a.r * cam.k + GUIDE_PAD);
    return cornersOutline(screenCorners(cam, a));
  }
  function cornersOutline(corners) {
    const [cx, cy] = centroid(corners);
    const edges = corners.map((p, i) => Math.hypot(corners[(i + 1) % 4][0] - p[0], corners[(i + 1) % 4][1] - p[1]));
    const radius = Math.min(...edges) * 0.12;
    const dense = [];
    corners.forEach((p, i) => {
      const prev = corners[(i + 3) % 4];
      const next = corners[(i + 1) % 4];
      const toward = (q, len) => {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
        return [p[0] + ((q[0] - p[0]) / d) * len, p[1] + ((q[1] - p[1]) / d) * len];
      };
      const a0 = toward(prev, radius);
      const a1 = toward(next, radius);
      for (let s = 0; s <= 6; s++) { // 二次贝塞尔：a0 → 角点 → a1
        const t = s / 6;
        dense.push([
          (1 - t) * (1 - t) * a0[0] + 2 * (1 - t) * t * p[0] + t * t * a1[0],
          (1 - t) * (1 - t) * a0[1] + 2 * (1 - t) * t * p[1] + t * t * a1[1],
        ]);
      }
    });
    return resample(dense, cx, cy);
  }
  const mixPoints = (a, b, t) => a.map(([x, y], i) => [x + (b[i][0] - x) * t, y + (b[i][1] - y) * t]);
  const centroid = (pts) => pts.reduce(([sx, sy], [x, y]) => [sx + x / pts.length, sy + y / pts.length], [0, 0]);
  const accentRGBA = (alpha) => {
    const hex = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };
  function drawGuide(guide, pts, fill = 0) {
    const path = guide.firstElementChild;
    path.setAttribute("d", `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}Z`);
    path.style.fill = accentRGBA(fill);
  }

  function prepareStory(slides = allSlides()) {
    for (const section of slides) {
      const img = section.querySelector(".st-photo");
      if (!img) continue;
      if (!img.getAttribute("width") || !img.getAttribute("height")) err(`照片 ${img.getAttribute("src")} 没写原图的 width / height`);
      applyCam(img, restCam(img));
      const scrim = document.createElement("div");
      scrim.className = "st-scrim";
      img.after(scrim);
      for (const a of Object.values(parseAnchors(img))) {
        if (a.size < MIN_ANCHOR) warn(`照片 ${img.getAttribute("src")} 的锚点「${a.name}」半径 ${Math.round(a.size)}，小于 ${MIN_ANCHOR}，推近后会糊，不要用`);
      }
      if (section.dataset.guide) {
        const guide = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        guide.setAttribute("class", "st-guide");
        guide.setAttribute("viewBox", `0 0 ${W} ${H}`);
        guide.append(document.createElementNS("http://www.w3.org/2000/svg", "path"));
        section.append(guide);
        const a = anchorOf(img, section.dataset.guide);
        if (a) drawGuide(guide, outline(restCam(img), a));
      }
    }
  }

  function storyParts(section, ghost, enter) {
    const oldImg = ghost.querySelector(".st-photo");
    const newImg = enter.querySelector(".st-photo");
    const guide = section.querySelector(":scope > .st-guide");
    if (!oldImg || !newImg) {
      err("故事转场要求前后两页都有 .st-photo");
      return null;
    }
    const { stFrom, stTo, guide: guideName, st } = section.dataset;
    const prevGuide = section.previousElementSibling?.dataset.guide;
    if (!guide) warn(`${st} 目标页没写 data-guide，没有引导框观众很难看出形状呼应`);
    if (guideName && stTo !== guideName) warn(`${st} 的 data-st-to="${stTo}" 和本页 data-guide="${guideName}" 不一致，转场结束时引导框会跳`);
    if (prevGuide && stFrom !== prevGuide) warn(`${st} 的 data-st-from="${stFrom}" 和上一页 data-guide="${prevGuide}" 不一致，转场开始时引导框会跳`);
    const isCaption = (img) => (el) => el !== img && !el.classList.contains("st-scrim");
    return {
      oldImg, newImg, guide,
      from: anchorOf(oldImg, stFrom),
      to: anchorOf(newImg, stTo),
      oldCaps: [...ghost.children].filter(isCaption(oldImg)),
      newCaps: [...enter.children].filter(isCaption(newImg)),
    };
  }

  // 推近式匹配剪辑：推近上一张照片，让锚点到画面上的切点位置、半径 MATCH_R；
  // 就在这一帧切到下一张照片（它的锚点也在同一位置、同样大小），再拉远回原位。
  // 前半段加速推近，后半段减速拉远，切点是整段运动最快的地方。
  builders["zoom-match"] = (section, ghost, enter) => {
    const parts = storyParts(section, ghost, enter);
    if (!parts?.from || !parts?.to) return timeline();
    const { oldImg, newImg, guide, from, to, oldCaps, newCaps } = parts;
    if ((from.kind === "circle") !== (to.kind === "circle")) {
      warn(`zoom-match「${from.name}」和「${to.name}」一个是圆一个是方，形状对不上。形状不同用 iris`);
    }
    const d = +section.dataset.stDuration || 1.8;
    const half = d / 2;
    const inE = gsap.parseEase("power2.in");
    const outE = gsap.parseEase("power2.out");
    const oldRest = restCam(oldImg);
    const newRest = restCam(newImg);
    const plan = planMatch(oldImg, from, newImg, to);
    const p = { t: 0 };
    const camAt = (t) => (t < half
      ? { img: oldImg, anchor: from, cam: clampCam(oldImg, mixCam(oldRest, focusCam(from, plan), inE(t / half))) }
      : { img: newImg, anchor: to, cam: clampCam(newImg, mixCam(focusCam(to, plan), newRest, outE(Math.min(1, (t - half) / half)))) });
    // 一个快门时间里，画面四个角上的点移动了多远（推近时离中心越远动得越快）
    const smear = (t) => {
      let t2 = t + SHUTTER;
      if ((t < half) !== (t2 < half) || t2 > d) t2 = t - SHUTTER;
      const a = camAt(t);
      const b = camAt(t2);
      if (a.img !== b.img) return 0;
      let len = 0;
      for (const [sx, sy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
        const ix = a.cam.cx + (sx - W / 2) / a.cam.k;
        const iy = a.cam.cy + (sy - H / 2) / a.cam.k;
        const [bx, by] = toScreen(b.cam, ix, iy);
        len = Math.max(len, Math.hypot(bx - sx, by - sy));
      }
      return len;
    };
    // 两个锚点形状不完全一样时（正矩形对斜四边形），切点前后各 BLEND 秒把引导框的形状混合过去，
    // 不然切点那一帧框会突然变形。切点处两边的位置和大小本来就对齐，混合只改形状。
    const BLEND = 0.12;
    const oldCamAt = (t) => clampCam(oldImg, mixCam(oldRest, focusCam(from, plan), inE(Math.min(1, t / half))));
    const newCamAt = (t) => clampCam(newImg, mixCam(focusCam(to, plan), newRest, outE(Math.max(0, (t - half) / half))));
    const render = () => {
      const { img, cam } = camAt(p.t);
      applyCam(img, cam);
      isoBlur([img], Math.min(6, smear(p.t) / 4), cam.k);
      if (!guide) return;
      const w = Math.min(1, Math.max(0, (p.t - (half - BLEND)) / (2 * BLEND)));
      const blend = w * w * (3 - 2 * w);
      if (blend <= 0) return drawGuide(guide, outline(oldCamAt(p.t), from));
      if (blend >= 1) return drawGuide(guide, outline(newCamAt(p.t), to));
      if (from.kind === "poly" && to.kind === "poly") {
        // 两个四边形：混合四个角，再生成圆角轮廓，中途每一帧都是干净的四边形
        return drawGuide(guide, cornersOutline(mixPoints(screenCorners(oldCamAt(p.t), from), screenCorners(newCamAt(p.t), to), blend)));
      }
      drawGuide(guide, mixPoints(outline(oldCamAt(p.t), from), outline(newCamAt(p.t), to), blend));
    };
    gsap.set(enter, { autoAlpha: 0 });
    gsap.set(newCaps, { autoAlpha: 0, y: 24 });
    render();
    return timeline()
      .to(p, { t: d, duration: d, ease: "none", onUpdate: render }, 0)
      .to(oldCaps, { autoAlpha: 0, duration: 0.3, ease: "power1.in" }, 0)
      .set(ghost, { autoAlpha: 0 }, half)
      .set(enter, { autoAlpha: 1 }, half)
      .to(newCaps, { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out", stagger: 0.06 }, d - 0.4);
  };

  // 遮挡 + 形态变换：引导框从锚点处填色、放大成盖满画面的圆，盖满时换照片，
  // 再缩成下一张照片上的锚点形状（圆可以变成斜的四边形），颜色褪回只剩边框。
  builders.iris = (section, ghost, enter) => {
    const parts = storyParts(section, ghost, enter);
    if (!parts?.from || !parts?.to || !parts.guide) {
      if (parts && !parts.guide) err("iris 需要目标页写 data-guide");
      return timeline();
    }
    const { oldImg, newImg, guide, from, to, oldCaps, newCaps } = parts;
    const d = +section.dataset.stDuration || 1.4;
    const half = d / 2;
    const start = outline(restCam(oldImg), from);
    const [cx, cy] = centroid(start);
    const R = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) + 20;
    const cover = circlePoints(cx, cy, R);
    const end = outline(restCam(newImg), to);
    const inE = gsap.parseEase("power2.in");
    const outE = gsap.parseEase("power2.out");
    const p = { t: 0, fill: 0 };
    const render = () => {
      const pts = p.t < half
        ? mixPoints(start, cover, inE(p.t / half))
        : mixPoints(cover, end, outE(Math.min(1, (p.t - half) / half)));
      drawGuide(guide, pts, p.fill);
    };

    gsap.set(enter, { autoAlpha: 0 });
    gsap.set(newCaps, { autoAlpha: 0, y: 24 });
    render();
    return timeline()
      .to(p, { t: d, duration: d, ease: "none", onUpdate: render }, 0)
      .to(p, { fill: 1, duration: half * 0.8, ease: "power1.in", onUpdate: render }, 0)
      .to(oldCaps, { autoAlpha: 0, duration: 0.3, ease: "power1.in" }, 0)
      .set(ghost, { autoAlpha: 0 }, half)
      .set(enter, { autoAlpha: 1 }, half)
      .to(p, { fill: 0, duration: half * 0.8, ease: "power1.out", onUpdate: render }, half)
      .to(newCaps, { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out", stagger: 0.06 }, d - 0.4);
  };

  // ───────── 回顾片尾（.s-recap）─────────
  // 结尾页上放一块倾斜的「屏幕」，里面把这份稿子自己的某一段页（data-recap="2-6"）按真转场自动放一遍，
  // 旁边 .t-credits 的名单同步滚动。屏幕是一个指向本文件的 iframe（?embed&capture），所以：
  //   - 回顾里放的是真转场，不是导出再导回的视频；稿子改了，回顾跟着变；
  //   - 内层一直处于录制模式（动画全冻住），由外层按毫秒 seek —— 放映和录制走同一条路，
  //     名单和回顾逐帧对得上，capture.mjs 录出来也是确定的。
  // 内外层只用 postMessage 说话：file:// 打开时两层是不同源，碰不了对方的 DOM。
  // 内层（embed）不再创建自己的 .s-recap iframe，否则无限套娃。
  const RECAP_TILT = 26;        // 透视右：左边缘离观众近，右边缘退远
  const RECAP_PERSPECTIVE = 1800;
  const recapTransform = (frame) => ({
    transformOrigin: "0% 50%",
    transformPerspective: RECAP_PERSPECTIVE,
    rotationY: +(frame.dataset.recapTilt ?? RECAP_TILT),
  });
  function recapRange(frame) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(frame.dataset.recap || "");
    if (!m) return null;
    return { from: +m[1] - 1, to: +m[2] - 1 }; // 写的是页号（从 1 数），内部用下标
  }
  function prepareRecaps(slides = allSlides()) {
    for (const frame of within(slides, ".s-recap")) {
      gsap.set(frame, recapTransform(frame));
      if (!EMBED) embedRecap(frame);
    }
    // 名单：把条目包进一层，滚动只动这一层，外框负责裁切和上下渐隐
    for (const list of within(slides, ".t-credits")) {
      const roll = document.createElement("div");
      roll.className = "st-roll";
      roll.append(...list.childNodes);
      list.append(roll);
    }
  }

  // 回顾屏里嵌一份自己，翻到 data-recap 那一段。稿子换了某一页时，嵌着的那份也要重新载（见 __orcaReplaceSlide）
  function embedRecap(frame) {
    const range = recapRange(frame);
    if (!range) {
      console.error(`[orca-transition-skill] .s-recap 需要 data-recap="起页-止页"（页号从 1 数），比如 data-recap="2-6"`);
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.src = `${location.pathname}?embed&capture#/${range.from}`;
    iframe.setAttribute("tabindex", "-1");
    iframe.setAttribute("aria-hidden", "true");
    frame.append(iframe);
    // 内层可能在这一页被翻到之前很久就就绪了，所以现在就开始等它的 ready
    const ready = new Promise((resolve) => recapReady.set(iframe.contentWindow, resolve));
    frame.__recap = { iframe, range, ready, hold: +(frame.dataset.recapHold ?? 0.7) * 1000 };
  }

  // 外层 → 内层的一问一答。内层就绪前发的消息会丢，所以先等它报 ready
  const recapPending = new Map();
  let recapMsgSeq = 0;
  const recapReady = new Map(); // iframe.contentWindow → resolve
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.orcaRecapReady) {
      for (const [win, done] of recapReady) if (win === e.source) done();
    } else if (d.orcaRecapReply !== undefined) {
      recapPending.get(d.orcaRecapReply)?.(d);
      recapPending.delete(d.orcaRecapReply);
    }
  });
  function ask(iframe, msg) {
    return new Promise((resolve) => {
      const id = recapMsgSeq++;
      recapPending.set(id, resolve);
      iframe.contentWindow.postMessage({ ...msg, orcaRecapAsk: id }, "*");
    });
  }

  // 每块回顾屏一个控制器：time(ms) 把内层回顾和名单一起拨到这一刻
  function recapController(slide) {
    const frame = slide.querySelector(".s-recap");
    if (!frame?.__recap) return null;
    if (frame.__ctl) return frame.__ctl;
    const { iframe, range, hold, ready } = frame.__recap;
    const list = slide.querySelector(".t-credits");
    const roll = list?.querySelector(":scope > .st-roll");
    const ctl = { total: 0, roll: null, busy: null };
    ctl.ready = ready.then(async () => {
      const { total } = await ask(iframe, { op: "measure", from: range.from, to: range.to, hold });
      ctl.total = total;
      if (roll) {
        // 从框下沿进，滚到最后一条落在框里为止；条目少于一框时停在顶上
        const boxH = list.clientHeight;
        const endY = Math.min(0, boxH - roll.scrollHeight);
        ctl.roll = gsap.timeline({ paused: true }).fromTo(roll, { y: boxH }, { y: endY, duration: total / 1000, ease: "none" });
      }
      return ctl;
    });
    ctl.time = async (ms) => {
      await ctl.ready;
      const t = Math.max(0, Math.min(ms, ctl.total));
      ctl.roll?.time(t / 1000);
      await ask(iframe, { op: "seek", t });
    };
    frame.__ctl = ctl;
    return ctl;
  }

  // 放映：转场结束后按真实时间往前拨。上一帧的 seek 还没回来就跳过这一帧，别堆积
  let recap = null;
  let recapTick = null;
  function stopRecap() {
    if (recapTick) gsap.ticker.remove(recapTick);
    recapTick = null;
    recap = null;
  }
  function startRecap(slide, delay) {
    stopRecap();
    recap = recapController(slide);
    if (!recap) return;
    recap.time(0);
    if (CAPTURE) return;
    const ctl = recap;
    const t0 = performance.now() + delay * 1000;
    let busy = false;
    recapTick = () => {
      const t = performance.now() - t0;
      if (t < 0 || busy) return;
      busy = true;
      ctl.time(t).then(() => { busy = false; });
      if (ctl.total && t > ctl.total) stopRecap();
    };
    gsap.ticker.add(recapTick);
  }

  // 进入回顾页的转场：上一页整页缩小、倾斜，落进回顾屏，再淡出露出回顾的第一页
  builders.recap = (section, ghost, enter) => {
    const frame = enter.querySelector(".s-recap");
    if (!frame) {
      console.error(`[orca-transition-skill] data-st="recap" 的页上要有一块 .s-recap`);
      return timeline().to(ghost, { autoAlpha: 0, duration: 0.4 }, 0);
    }
    const d = +section.dataset.stDuration || 1.4;
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;
    const s = W / w;
    frame.append(ghost);
    gsap.set(ghost, { width: W, height: H, transformOrigin: "0 0", scale: 1 / s });
    // 写在回顾屏前面的是底（转场时就在，屏缩小后露出来），后面的（名单、标题）在转场末尾淡入
    const kids = [...enter.children];
    const rest = kids.slice(kids.indexOf(frame) + 1);
    const end = recapTransform(frame);
    gsap.set(rest, { autoAlpha: 0 });
    return timeline()
      .fromTo(frame,
        { ...end, x: -frame.offsetLeft, y: H / 2 - frame.offsetTop - h / 2, scale: s, rotationY: 0 },
        { ...end, x: 0, y: 0, scale: 1, duration: d, ease: "power2.inOut" }, 0)
      .to(ghost, { autoAlpha: 0, duration: 0.35, ease: "power1.inOut" }, d)
      .to(rest, { autoAlpha: 1, duration: 0.6, ease: "power2.out", stagger: 0.06 }, d - 0.3);
  };

  // 内层（被回顾屏嵌着的那一份）：量出这一段每页的转场时长，按外层给的毫秒数 seek
  function serveRecap() {
    let segs = [];
    let cur = -1;
    let chain = Promise.resolve();
    // 往回跳、隔页跳没有转场（见 beforeslidechange），拨到终点把场景、视频也放完
    const SETTLED = 1e7;
    const go = async (i) => {
      const forward = i === cur + 1;
      await window.__capture.go(i);
      cur = i;
      if (!forward) await window.__capture.seek(SETTLED);
    };
    const handlers = {
      async measure({ from, to, hold }) {
        segs = [];
        let at = 0;
        for (let i = from; i <= to; i++) {
          const { transition } = await window.__capture.go(i);
          const trans = i === from ? 0 : transition;
          if (!trans) await window.__capture.seek(SETTLED);
          segs.push({ i, start: at, trans });
          at += trans + hold;
        }
        await go(from);
        return { total: at };
      },
      async seek({ t }) {
        if (!segs.length) return {};
        let k = 0;
        while (k + 1 < segs.length && segs[k + 1].start <= t) k++;
        const seg = segs[k];
        if (seg.i !== cur) {
          // 往前一页：正常翻，转场由 go 建好；跳着走或往回：先硬切到前一页，再翻过来
          if (seg.i !== cur + 1 && k > 0) await go(segs[k - 1].i);
          await go(seg.i);
        }
        await window.__capture.seek(seg.trans ? Math.min(t - seg.start, seg.trans) : SETTLED);
        return {};
      },
    };
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (!d || typeof d !== "object" || d.orcaRecapAsk === undefined) return;
      const run = handlers[d.op];
      if (!run) return;
      chain = chain.then(() => run(d)).then((r) => e.source.postMessage({ ...r, orcaRecapReply: d.orcaRecapAsk }, "*"));
    });
    Promise.all([document.fonts.ready]).then(() => parent.postMessage({ orcaRecapReady: true }, "*"));
  }

  let current = null;
  let lastIndex = null;

  // ───────── 场景内动画（orca-motion-skill）─────────
  // 页面里有 .mo-scene 且页面加载了 motion.js（window.OrcaMotion）时，转场结束后播放场景自己的时间线。
  // 本 skill 只管什么时候播：转场结束后开始，离开这一页时直接跳到结尾（ghost 克隆拍到的是完成状态）。
  let scene = null;       // 当前页的场景时间线（暂停状态，由这里驱动）
  let sceneCall = null;
  const hasScenes = (slide) => !!(window.OrcaMotion && slide?.querySelector(".mo-scene"));
  function sceneFor(slide) {
    const motion = hasScenes(slide) ? window.OrcaMotion.build(slide) : null;
    const lamp = lampIntro(slide);
    const builds = buildsFor(slide);
    const extra = [motion, lamp].filter(Boolean);
    if (!extra.length) return builds;
    if (!builds && extra.length === 1) return extra[0];
    const tl = gsap.timeline({ paused: true });
    if (builds) tl.add(builds, 0);
    for (const x of extra) tl.add(x, 0);
    // 场景动画、开灯算在第 0 步里：第 0 步至少要等它们放完
    const stops = builds ? builds.data.stops.slice() : [0];
    stops[0] = Math.max(stops[0], ...extra.map((x) => x.duration()));
    for (let i = 1; i < stops.length; i++) stops[i] = Math.max(stops[i], stops[i - 1]);
    tl.data = { stops };
    return tl;
  }

  // ───────── 页内动画：关键帧路径 + 光束遮罩（transitions.md「页内动画」） ─────────
  // PowerPoint / WPS 动画窗格里「自定义路径 + 陀螺旋」和「剪除出口的遮罩」那一类：进页后元素自己动，
  // 不是翻页转场。和场景时间线走同一条路：转场结束后开始播，离开这一页跳到结尾，录制时按毫秒 seek。
  //   data-path="t x y a; t x y a; …"  t 秒（从这一页的页内动画开始算），(x, y) 是元素枢轴点落在哪
  //                                     （父元素坐标系，直接子元素就是画布坐标），a 是旋转角（度，顺时针）。
  //                                     关键帧之间按 Catmull-Rom 样条走，时间是匀速的。
  //   data-pivot="x y"                 枢轴点在元素自身的位置（px），默认元素中心。旋转也绕它。
  //   data-light="键"                  这个元素是光源：从枢轴点沿元素的「上方」射出一束楔形光。
  //     data-light-spread / -width / -on   半张角（度，默认 13）/ 出光口宽（px，默认 0）/ 几秒后亮（默认 0）
  //     data-light-grow                    亮起时光束从出光口往外长出来的秒数（默认 0，一下全亮）。PowerPoint 的「擦除」顺着光束方向
  //   data-lit="键"                    只在同键光束照到的地方可见（clip-path 跟着光束每帧重算）。
  //   data-light-spot="键"             光轴落地的那块光斑：引擎按灯每一帧的姿态算光轴和「过它中心的水平线」的交点，
  //                                     把它横着挪过去；光还没长到地面时看不见。光斑不另写路径，和光束永远对得上。
  const LIGHT_L = 4000; // 光束长度：比画布对角线长，射到哪都出画
  const parseKeys = (str) =>
    str.split(";").map((k) => k.trim().split(/[\s,]+/).map(Number)).filter((k) => k.length >= 3 && k.every(Number.isFinite))
      .map(([t, x, y, a = 0]) => [t, x, y, a]).sort((p, q) => p[0] - q[0]);
  const catmull = (p0, p1, p2, p3, u) =>
    0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
  function poseAt(keys, t) {
    const n = keys.length;
    if (n === 1 || t <= keys[0][0]) return keys[0].slice(1);
    if (t >= keys[n - 1][0]) return keys[n - 1].slice(1);
    let i = 0;
    while (keys[i + 1][0] < t) i++;
    const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n - 1, i + 2)];
    const u = (t - k1[0]) / (k2[0] - k1[0] || 1);
    return [1, 2, 3].map((j) => catmull(k0[j], k1[j], k2[j], k3[j], u));
  }
  // 入场 / 强调（data-anim）：PowerPoint 动画窗格里最常用的那几种，写成「效果 方向 时长 @开始」，几段用分号隔开：
  //   data-anim="trail right .5s @.2; shine .8s @.9"
  //   fade 淡入 / rise 上浮 / zoom 弹出 / fly 方向 飞入 / wipe 方向 擦除 / trail 方向 拖影飞入 / shine 擦亮 / out 淡出
  //   spin 回旋（转一圈由小长大）/ emerge 升起（飞入 + 遮罩：从自己的底边里升上来）
  //   ink 墨晕（一团墨从中心或某一边洇开，洇到哪元素露到哪）
  //   方向是「从哪边来」：fly right 从右边飞进来，wipe left 从左往右擦出来。
  // 点击分步（data-step="n"）：写了的元素（或它所在的组）等第 n 次按翻页键才动，没写的是第 0 步，进页自己动。
  //   放映时每一步放完停住，按键放下一步；全部放完再按才翻页。录制没人按键，步与步之间空 STEP_GAP 秒连着放。
  const STEP_GAP = 0.6;
  const ANIM_DUR = { fade: 0.5, rise: 0.6, zoom: 0.5, fly: 0.6, wipe: 0.7, trail: 0.6, shine: 0.9, out: 0.4, spin: 1.2, emerge: 0.8, ink: 1.6 };
  const ANIM_DIR = { fly: "down", wipe: "left", trail: "right" };
  const TRAIL = [0.45, 0.28, 0.14]; // 拖影：每份副本的不透明度，越往后越淡
  const TRAIL_LAG = 0.05;           // 拖影：副本之间错开的秒数
  const SHINE_BAND = 260;           // 擦亮：光带宽（px，和 tokens.css .st-shine 的 background-size 一致）
  // 墨晕的遮罩：一团边缘毛糙、由浓到淡的墨（320px，webp 内嵌）。不放成单独的文件 ——
  // 引擎被单独拷走时文件跟不过去，遮罩加载不出来，元素就一直是透明的
  const INK_BLOT = "url(data:image/webp;base64,UklGRiJKAABXRUJQVlA4WAoAAAAQAAAAPwEAPwEAQUxQSBpJAAABGQaNJClKP0O3f8GPEiL6PwEA6y0cVTfdr1Tinb/Uma7Q/Y2lKzB5XcWjoG0bySl/1vdgiIgJgCqo2tl1KNi2m6299tPCYM+iq9YAkCzbdqXx3+1zP5LuXocqUM6v+Vx+ZUCTYEHaAF1+xHt+wYIsLhmwhxdJBza/j28HkpQBxwANXygiJ4CPtk2OJEmQBizGGOO9/90wRkR2NeBy8U/JIuHH+MoD+ICfE0YPMM5H8jbo54RRvv0AkbwtkAOs8eV89AGUEX7tABW8NxMRE6A32yZJkiRpdpeK5Z+0+14iMiu7O8cjYsAfkr0UL8c9CdA9fkz2UALScS9cIcEEKMMjCPDCdQ8hoA3PwK0JEETxMgI8cGskIibgP+Gv/v8r8P/iVx/8pf/2a8//0FsCv+ro7/8nlP/NV5u/L/EPNjv+q681/Af8L0fk+M/wtVbOFaq1vtqwuODjP8ZX2+7KEP/LrzIE4CNK679urD8cv0I0E+qu5n/xn3r+oSinfXXISsmK1dxb9gfqAvPrQxZRKyvDeeAPSpVF4itkQrQEKYv83Vj5UyAsAYD8gvxqABBxRCCM+N3V8VsgCQDVYKJHgfabBA7KSy4MPYkj8bvTZflb4Iv+RyqGt4c6FylNrzm243jJAfUP257C767+x66152/TNbqqts8LyWxnVnFcyYHti/jiYrl8t5+QK/I39Da5/eeWPyHUP9Q2/tHPa8KKoU60i6Uj7jm+YJZ8aSF8c+4BEMDnP7XZf/gb/A6Qab9B02kBxnb947QDjvCu7TluYeSI7XOBoODFnfznnhdWxkj0P/nZtyOBOjcIx6EI4Dqvc5XpPA/M0cfBq+OcHQNrjzG42iEAbA8OfXnx86rzeR/xK/6Zh48VsIX7N0LrtWs4xj/9zZk4H9eYrxe3XEC2jL3LlqoZO2Sa23XdYPCXFcd1buhrXPWfSNs4fX8vs3mGcr0KvZ1zq8R2jW1o3F41TreFMbO5aPTuc5nLaqWoLfR0fWlQ/INsj97+he/3x4jXWWtcw9dhzi6Pj7wGWdsWxnm/PNPau4KeRz2+UdFDkenPs3Evs6Bzl7viZUn1PDPz99OQa/S/8c+OeR+iV9fp4tLY01W5N9R5P4PhszdbZ5wDabny2nwb3Qku4zUZ63JGHkdAXxJs1WhoTEagfjd+O5Ow7a9+qqnpPfN+WYw5Y4+bKRnVNebKZFbtieZVh5nFNt/X/Tyn2fVhuTz2gFLvbgHVl0Odo1sr1WN2nchIAPyp8X0zM/3zP1AOtR1jjNfq9ngPO/Y1z051WaVhEPQ6fMTr7C+POPycfZN/LJN1URWJGgZDfzFkOZC5zMqvAfXYD/YQ7DdwG7u4fW66VQv7cntcH68UFXX7OD6yYrezbEXqOHQ6+1o5E31eFbOi9/e0+3UDJpSSk0kzdfmDyGcaPF8plO8x+HkGsMbjx7fy9QaAn/0f/LLGt8rbMVWdV6Xm8WGmav5Hsfb9tYfduFWYsLISmiMyNp+Nc0rr/e20fiyFw11g64b0Weim/iWxRD7TmpEJYDHv3waOdd3v53j6jGPPfujff6X3sFvWGGPUnKV8CzO69uMIJirMcFVmEkfG7lstlRPdKaxfo916GAzSB8LmYdpZlmIpP2ULuj7TSogwKI643/WrJD7PqGtgWe4f93PZGlejRJ89uuvIwxBBn9zJGv/SUB4SS0SkvY6agAlgKuP9cAPhhPQDqsVKl6CrW5jqJ7S2izv8WRa2MgoJzR33fCP9cTJdirzmO3puAOmjT0adhOI9eGDQME8oz/9rUFMLVNGOFeP4uPWcFFERi8EibdnIMQFqjlHdFAqUmQ42tG9T2UL8OfZlgsDns6Km1vbt6ZmZKCWrQ8/rFTzPUwu6GAQrLLIsRqfdf2w/R1eTFkRqB2zVeW2RCiF3S6vUOnbPCGYqsWUaGc6r6eBbiXM7z5EyTQAL+LML1WnP63lvPOc83b1309kfr3OOP939Lh/nlHHAAfbgOtaBvmbaMX0dCJRiBZLIUt37LAP0snzdhCKDmQJVjFnmHOLkbG1gWtnP54VBx7KuHPZeGO7PrBpzPv6v7T4gPXpUQFpQxvj8tpV8fv55u3snPZkwcWWuVM2Zx9sYZhFAgMvOAZCjz/Fu4Pr33o6WCV4hIFwcIFGGLLMVs6WghIHpC+csczlXXScCoNtzCt3f/91/LTT6MV15FJs3ZGVvz+8z/PkvfnZZWFUzk1iHWsWrc712lJICYJW7ixSHun75WPu+H6unlcpWjJWiUz0tzGp5K8ta1r1ESB+qpbm0/W0FooNggPTPse2qzxye59/6q21+9zFXQFvHRyfTH//X57Py88dsR9iLo5EQEskTr+n7HvEzBwRmknXgMSnU+bDcD6tzwLIJWYBFxcyRoO069uuVjWjtylR3tn0uyxLwzQlXFYJ00Ja//sP/s+R43px/2hhAJc+MrrPsltXMb4/xTbyeV/FAsw5zkQKoxnqZRXq2ryopD69DuM7L+/M6brPz6hrNI9QqwvYzX0ZkZNXJPtEZEhpRPm6rzuZWkHc7T5HkivaB+M347dyW9jieM9zmSRCqO9mNXGExT+nzep2+3QtpliV0UlIJDWEPi+sxP8dxI+UVK9IZ1/PbX73sdkT19fx+to7brarwik//MEMiPWzMVCnkCScOSbSYpp3zvdHuCbN12ef7b2X6LEN7f87Uo1p24H7OwJBWLJ9V7ZqizxJpmawuogsgpKoslMZ81JFUexh4IqbPH4/Z2CNq/vnbXbIdoTj6ed8/ojtLGq1Y5wwwwMZaNQqkm2m8fZiPG2esv+G+r+t7YfbMO0B+tVzPzPV+cPsB0EHQ5nWO6z56HsluKTODBUSImfCWttLEUf3wD7QFxjl0Xk7DfbLbP2xwzlIeoF7+vKA4kl2denzWmzzphF573i91uU3VdZ/rTEvM928753W3VmyIhW6Or9b75bm/FhB9L1mixjl8+lDNe66gxEogQoJBzPLR6jFqDiVL4z6rUETPLn/lY3A7YXajinXXsPDG6YctulT30Rv/SLbnbrftm2fW7Chz/eUNsTjfJvewt51/aRpNtcSql0a+TmqD6ThKFcZpK4J9H12RdT0G8qAqJQuiKAKhLpKS+noK70ePvj/udkBg9UT6GIrHhfjVzvntsz/G8/iImbFzPHo8Tqe9PnT2ccysk8hsesyPX1pMK+v+dtaU2c5La8rYSecYfURfGwTgT+3v5mQ1ybfDbI3Na44xLqfUHkSiuVAkuwAVCbDGqI60SFzOFEB1in0SYyTEsCU/lXjquF0Duz/ars+zImU7xrwd5za0YniW9vMSlmZR2r5SZ1ve/ouJZSJMTTfQ0tcFZwW2pxQJh0UY3ez0+YjyGpylGhMRCVIWLJYixaSQqBoDaYZRg/thHKNU0vM0iArL6+QeKs5m4XGKm/QaV58L5X7vm8T7uWA5K/u6uHSGOxFlWdtsb2tM3IcfaUVvoesrY5yjsDVCtrKPAzy81/yhg66SvL1FBQ1UiAm2MhOZBUizFaxsIvFSg1SduG9HDoLqbhagrILOh9v4rNsyobpK5/O+jfOKwAot1Om7iGg4XFMQZZY5jRAj8sDYZIGer4q6mHU1ct2On2+I9eUEnm3DFrzVpYxUZgKpYgJOINkAOAcyUhWhJGKb/fIf45xmRbK6Z6sdKC+yR1jqkG76ptukrmv2mMPe303NlE9150hSmcNKBOiFZkMQ/fZ9sKpTXxPsVo4Nsth/jrQVtpYafrZwqkfJxVwGAxYAJolCUY0k5LGIsIokmHtdI1HnPYO+qOrR1ZPyHkohCLN++Hllw+YYHVGpEdgDLmWZJSgaoc69Ocwm6dYwtsflzuWsmF8TSK45WCJ1M0TlShsyXieuwTFdiWJYoogEMlVUZpNSQtUE7WZiAEWdGRndNE2hvEusOctbTAoZkWPU6IRbOiszSY65H2MeoQwS4e6h2VrYMhEGzrV5r1suhnvlK+MW3UgUEQY0c/aKYhVHqaYjg1UGEqJoO0gaQdYo1KR35ZFRAmOODI/3pYZXjUGVo+RFr2ErBNItAIqsgFdkkPR5O775emWCwZECR+zGczM6zQjWIZn37NRXAfVTyHytSVbRXpbyq+y193jbHtJ2SWVR6MiMQeaK2NOAFaEeA5JIsao8jGqSgSzUgOY1HHTROL28GxDSIKrUIoOdQAKIdpBaO0gbql1pbwXFACOc2LbL4PD+eBnG469G5k8A2HtQ536zRPJ52X6L+/Wns85ZhWRkCUamsB+oXEwiWN1MU1FBb+yrzrPoYXpeqnbvgp/dHumuTPUpITtUVWwXE0iUIhl4dOzWfUOos49o71G1TAAkIf/6h41LFx0J8vg4ciUAkF/UfSRmrFyG7G/fjoOH/+j6LNDLLNnNJHfLoCRkkhrdQYmQmIAt+FklluhUn9MdqKHsccJiHRHVJQEsEjlIIrKqlJnBbdRrbceIpmNirAvpIwI0Q/6bfze01zGVN74GNWMBQJ1Ow/WtjPd8WxISffVQaR563EeAXFlZVSrbjyAyKIiAhsgmACbASLAKlCoxaswqtDMA1MCxYGvlUAYiKcozwJVVIhphR7MfVXcomKb1vkyjq88IH//qf+d49LWl9foqqEIy6dv2eUa7Nz6v14e6gs2f474976jnOUQ7rLtEQGHGsOWlzMxC1HAGWwhWuUNJFRGZdR8NSoQAfpm2AmTll+p2IiMzKSRF2RH7ehv3NRfvyZ5eH7CYKjYdr/9yuNOmZa/4GlTtOZXn+P55nYWxdU/ugSodeY2s52fF/TlWao8eagmRYZmxJCGRBKtGNYWAy8nRtCARAAuzqGJAYAIqhaCstMxI+pxhEWlV+JJhi0W7vY7Q4jl7F+s+xYXR736RMjUWV2TX1wCWISfH/fNvuXp0jZKFbEU9dP74N+8jE75nR4BzVkJxRBpWsphoZILDB7LIHNeA4AJIWkJVJNRAghSdIUANmUUGwl3Mg2FsFknguOnyDotcOpWo7mZhOQpykx4oM2QWMuy9vgaA4hjz8anrwi6vXu/QSNPnv3L3a1i1W67FwaA80yzDYEkKycqAvmyx230WpFbKCYDKktoRYLKqh8JCwyJjT4rdHVFMBpBEGszy8oCFJEuQmzbo3Isem5TQ8OFlEeNr9cJj54ABOp9D9ePPNDXDK7Heo8fIyfPPn7ubZAro1iMTFTgiIzJEMJEk5GdTLKEn5aoKKtj0KUnlU5YUNbohmgF4HYEE0RSTTjCDMFupYEcw1dZljCIC1WEfgbtNuJvBlWt5/fk18ehr9oH79/M8z29lkoqsiqygcg4/T/czMG6JXseq0dWxpKAULCEyS+wxBIolbwrKktLSfbpUYg0po0a51GQgFgCEmiyBCUkCSgyNLoUlDZU5IQ3WpWfdVtPwfmS0IFHyUQcefzrOH9f5+fmpkq28X0AaSw1N9T3yoTxvVkKk1dUniBKSENBEVxdPp0TRB6sTFIDMdB+zylnK6oSfZylZMESyCKFaTDJThEiN8s5IZkK0BMB9YNRRkTfYbjmGeinD++3XUfkcqM8f9/u8e6V0bbe9B9KC3ipoG1D2dupAMFiP56WQJEogQ+wpjcmkOwH2qEhAkUSaNSX1LJGBOcfoZiroOsEjKXgTJIgEoKactwV2hQ3tIVdqHXK5q9LLaiKpmdDHj8u24VkY49N5WhNVc9vGS5Zp86qt+35i61/U1piIifu3qVASksrbFGgSElSlRA0PMQCCSCCSkczhVNLdQQnUWnIqdw3V0JFIMDNTahCHLTTLlvxAwGtEoB9J1QJME1f1Me6H5PMg182TMD8Rw6/zYu1+yudzbu30Wr8YdfhD/nm5QgBoQp9dhSCQbKIUIoerxGAkcazyCQOkYtInllrIOBbZzBswLq0jxEwakPImFnRkc91c4Dkmh7RY9qsJpbu26aljU8p24Jm43t713Lau0aWSRHgd152fT7OB3NfY2Orz3E4mM0EQ1QVICgOjW4OU/FIxlyLQAGKcnjd6ieohZLdS6yBXVi6wW/uqrtK+CHmpFGYk4mUDWSVaDo/WztMW1BQNd2OvfYypzwTkPv7qHc26DE0pRmue4qmRS8u9dZ5c13X3SKgb6Q5lIAhCkWyXyHkvYAVXzE76UEmI8gS9ijlJgGAzIi0RQnnVGIO2QtKcWKEEbM/MRJNyI9RjAiVTOt01EzK2o5XxXACvx8kyqy66qrp8q9mRqCUeV88B9NyazCqqiiAoFatdkSHJpR4KS8pKwXI/48jqUgswtDcBstzFSFp1iJqzkgIS7MGICGSuV2p1ZR7feyPCZSCotXoIam6PzXnVfDb44+p5rBu2E8HszqqGSqID4uU9e1aiSsUkBSKzVVXqqk6bKpeEBECmUOpRaaxxauBAoRwEAArdGQS6QZyflRJVCShzZUZWhI0i0v64aWmGkT4stgrNTO+1b1hK8/5ceG6X/bw2+TkRgjdCQldVYQfVHNcsK6mLkaAIQRQoAaourwpK6kIKIZdLUtILQlWCJH6aGmV++QDG8B4MCEgl4xasCECFIP6/P8JshqiI+1GrTxmi2xjwUkLymcDrT+yPdc5vV0CEGHQqSiysapvFYxtA27TNBJt2QCbYm2MBKYZswHIHgDcaJIAU+qd8WejkfhfDdmyl54427CaxTsWf56/dipNw1eNxSLrZ2PoBILuZPw/4+DxfGW/Lr41FgNkFEOhEP28lHR4fF/jlbsaRgGxUYBPUTTSynQD5wCK+ZIMy/pz6VgYCE711S7PbdAdV6zz9K5H1dunNbOv9xvDU+sCnLp14csnfR83vW66PFe/0h5AkUJVQSySP4+799HFdxxFyk4ANu9h9JEIaRiZ0MxDI8dYPAMSfWylA2qAxrXSgHMF1UevveI4cdfRLJjYd94lx9I2feZKp/H3oczZxvIdxRHiRCCizSu0lX/vjX8exDyYdb4Qwj20Q8/xIxFYBmOxOCkzgxl/uBmAQcldasdQ+rwNC9H5Qh9B77xfnMfQ+MmH+dDGVv1vKbOzKTHrbnJEQd/JEiXL0r5f3tTkikoBgE3arG9eGAteIG5k5CIGb+EvfNFBungmbn2j2MoO0ipMqRbq8cuCzfLKAwm8ifwu8buuIFcM3jW+VYkQWVSUkW+iDPlCFGCFBdnMfZG/vQyCqCuyPnZGpEH/xJLqryAJoTVr0nmGHIqS79Wk3cQeIJ72SzC+AYv5EJuhwcvt8XgcAku1KJ9hBw2G7BJIO7SZ67/3cDsnGpBpwGwDYyF8eQFunrQmR7IviPgGsiIsaVJF3Ki3gT5rEwJeCAj+p+za/DzGvb88EykEVWiW4jqCJqBvoTcTNNkwabgdkIrcD4gdp/CKCKL2DYnknDhutf9Ld5qEIh0Nb8cSTnjG0AGgwfqrGZjy3MZ+PkWSNqhLAKmaKwnG5Zhv7YIMBDbKLTB8kEmyFTv3QL5XArlpPJp2M3PupQ3W262JShdLn2oJu6U8ZgFE7arLsJ+itUeXg9RSrJ1JSZiYFMOnrMjvNhpsAYKCzge6j0+z59N7N/LLATopdIFFMwP38+Bd+c4u99Z6VEVd4mTKeNNbnD3uNrlwq+w1DGCfIPC+qhpBJBDIkAeBhd29gJ0CTbB8Ams+L9tQOcuyj8Esv2HCBQEhL2ddGf25LKYbqPjBnKVObp/5x+DT0VfenmOuGbRgCoNpsKwwfAHS6ICEjQTIR/TxEb/cOkN67G+0Y19GmVPA+uvGLr0EfNjSIDQaH97z3v/a3wntbAPq6ri0+9kGFfBkLHEZ/EjRmrHPansOBQSMtKfcaftMVh2e1EgwIJILH9ye5j6YGPNqNvQ2bbQMIYl7CLz6683w2dnSSSUySWfyff1m0oLfpsaz+/pu1YaWRQ/1zpWjZl+queApZ9+0j8ii4sswGmK1EjVFtH6l2BpuEkpIi+/m8rqdNZLCPw0cAwh9HAsNDdOMtZNuNGUIhTLCY+f6B4oDbucQW6/UavB9lObezOTMBxLfF9l+clgPAPG3ycZ8REbnowYwRluneqjEf0/myTHR2E0BWg5D6o482bR/e3IZDo66jSRBt4g1M2Bd0J+hQbZsgSHyUIGxfzEfuy4cN7fXj462U395n3jrYynw/L+ZdE3NfUx3hp2psfo6IzmWmocx0M9bY1M9nOcurbu91b5JM9SC66ni2WwD37k4ZQeDUtU2Am3gTJaY1xePa2BGuYwuK1ELjX85N+b60VYT9wPrXt/bLe2l+H8vHwrdiZV1ls2/vlol1hvXTlPOqTp0rWPMS1pJW6vR1PgbmWV0pq/tICSEnWD2fgKXVjSYQMnTo3iR+OPzlkSXWgO3d7OOJeynZPKI512I2z+v7UmL1C9rtcv3t27rsvJ5/+fjLGcsq5XwNff8v+7Ji3Wvj5qdpbIVUXJN1WVbsNKbP6Gew+3wCqcclAsUYvUy9XSiixm7aogPTALH9Y8QbyCyITQBPF6+rPj/Tx7GBua8uUcpqNC4r8toven27tnX387//GCil0M5+/XbeZ3yc15iQi5wkjmJ0ruqtLMgMoxF5bepzZm+UXw83pKRuooqnkAS5NuQjIEAixAEzMvFGZqTuoOneyJcj5uNpkY65lHASggld3tklrK3Let3LkFlIN/CjhMWyBj/KdhynKYWOIwxZCr4CKRS98LGv59TE+rDPrUASgyKL6YhgeoeBA0j9A0SSkH4bqLQSsI1+rjiTwMcGNXNaLIVD1Qlfrm0NbTB6WUGkT3qhRrNpjNK9bGP0kwRrW2EMoIi325GRw7zXwu3w8332X/mbOkdKhiaR7CKdJH20t5cSJgGBgUSgws03gRGhhsAjd10UcDCLYNpqMXkIDEZb5r6ez6oGwlWKdnfMlU5zNbjs8o/y3PUkxa2ZEDOKZSeFjyjrpHj7Kytj/Z+3a5xtkgWSBZ8NIvRuN0uSBQbtKEK628LbSIiJ7ZhDzRESYnTMnIVlaroyIpopVtAppJkiVNUiPAhTb9JjPn6+nG2cJAQhpeV9dE71AGscN2H2fnvHH3UuPIYTwYzoivNsxU0CxFSlBBXp62C37W7jjXQQc/bhrTqmssuppW4VPU93SzWzxjCIQelJo5qqI6zkIZimsRQt9l3um+M096ggze8Vy1nec2iPb73CZ6zMbx68CkExDX5SlTCkClXybgIAr+vq7G0Sb6UMErbw3RUhunrfNbQwC0JkDExPZ7NJNZIUV4KZ3hbnSC0RTW0twjiGyGnCKGawhgy2jtbkujY46b4A274fr+EkUil0L0YSKBhO2CRNb1s4SJN4I4PF3yv7mXftxZ1QfUXTe0vXqRiZ6l2yT+OcyUkaUgzELFOUy0rPZkrSy9pm3/IkZZZI1sy13nIbvoytGi0Shi3sWdYhUiwiKhMV2OzAMEiyvdGE8WYGGe0ncHRZr2qGsADvgLsZw6sAq95sOgC4IoyS5jCfi/c0gKNiVQdrLXPGuJwkXBtZTDqgPg9LiDXV1YUYD/p4P9jdPU7FEQQIgMLVQGzARnMDJt8MYu72HEfcew0TAnGKBkACTvhci+UwhqcqkRiguzuHo7D3rg6ZBxZuR0z02zhJLN/cy6W6tj7MqoSsVrMLUwxk2NNZ3lzL1N1hAoYkuEk2ESPw2wFIppnM3iwhIAimSAAEVNxjYZmaDqOlg1RI7Y7wTdK6Zsqc/cjJXof0147TvN/u1xyCXOPsMRncSUDlZ9sBGSM3N3DYoRqngoyAee1tGgiONBk0+XY8n1Nja5mJSCAgkYIJwKGmgMUa1Z1mQQtVPdKolJuM4d57BhPjuNneL/e7nB5+USgd2c1qYH5umTzCDAfHhttBhbL8TiBq9JidFgoKgG6SgEkybMBvB48rBUdCgHLEDhDEAOieTtCJYl0JlkIOkTopNFFar6qk10SRPsRlO3BySwmwz6Etx+mZwTFytONXk0Vg5OuF5srz+xCzZsEHAAbo3kSxuY8NETbijbfUdkIDVgBTIRI6ANy1w+h0KF0IAuZVqD7EYUDfBGgzVVBm+BjUm5+eYqCuv/Xg+bn58+2Gs1/q4X67xVLaW0rZMfv5/WCJQo1IlwUf3ofK3y9vdrMFYPtNAWh8SSSAJYJgCHiOQRicrh0Gh5J6pGCp31mHy6g396lO7ZNByUTmODmZZG1/9eTlPpW4jev2R1Do/nW5ECtzcLsunoNSlrdTg4xDqWhjuwZtIjGDNzmEkcCSY0Cg1ioAIEhaqKLmHlSt33itc/QOczVXe9RiDs27ztFPDs+uz605NS/FgWq+HSsGIwwlVIVg/ajv0wZDrvZOAfATKxn0njpIBDDxVhMORdg17KQSESJ6U7RLLs57hY5e7xthrPUwSFAPcc9tiKiaDj81s8+tmo/m/q3tpmLADusyk0WJgpT749s2VGxCjUCTAeAAOXoGNt56UgQAkbAqC+64SRBrxcUoKSmo1d/0fSlRsCX7UWl5H/1Qu/NN+4mpq68L6PskkHXcWnmA7ant3gEXQsO3+x3zQbEwagVMha4QMbeKMt88kABAFtApMgQcMFDWQNXm3COuz8/Pc/2N2Mt4HV071YWkTXnc03haxsnPUYXzPHmZHZlJO9AduXZsfjsKhetxdv563ufoMRuLv4EMAxwoNYKH2SrFBNHcoCnYgxaY8y4B+uP+t5pTC27jMhXBgHnG9FoPnNI66+nnFV1jHJfHYnJFQil+vDJi3QLpSp3j9gufcw72GK6sVkQkQXdPqfE43aOJ0yZMJhIrBtpYYSH1rtGckcc2jJIhTihIk9pxUuf37XzGbYxgu+X7krxuhxRYRHp+BBPFyP7Mn/3Ro5rl7dWMREC5TWqGFP0gsD0KAAMF6+5eheDZCEIj612KzrscadWK5HSVAACveVqOYxsX6ySO2YewQ8obZUewS1ZlCF3J089v5667tySgCrAEQRrCYnPFMR8EthlgxXUvLW2NSDfZa2wr5xoh7iG3uL6FqtIBqHfV0wJqNGZ74GNF+WGV6SkzVY80hkVe/9dfTT608rmdZHuGioGkEdCp8+Zx7eCB0oSnlu57FlEx4QahVTIVfSMYCz/mx28upqrh6uljmJ8WO9wP86tRiluOzFg9IpmKEsMy+/n4W1tv+xu+f46sBqoFWgBEUPAEthE/DhCIgs8bvZsrm2ZC4L4DqvH3Abu0wbLwO2exrk7VcZifmFwvjuU/zjrrfR+jGRmMWyUTMh9+OTvGSL/fa3R1JkQiA81VaFRMm4nAx4F0FpKynQXapILcK2CI/ccfvva57TNbdTNGKVV6qKrg1N7ehNT3DXusxzmO/fYhmIpUnXNcn3oZ9/LerhYLIFONMGlnqg5CgdiMHgkrXafdROEwGZjU+ylsqq7O4ef69tHV0Ro5z6x31606Tu/ax/GyKSnOoVcOpZVlsX07Z59z5FzzGmRGZhAFQKxWdVJFdJSySTxSrb5WbC4dBAACmlsCAvY/fs/vAX3IzqCvzQeO+qOCq8qpQTEznK2JUZHdDMaC6oKub141/QKVAGCpVhPeDc8wX8LOVLMfigMbmYpNgSHnjoJE3X5+UPewtk9vAdHMgNdXYJ3DT09/fx4H2ds5qawzIpmhweT9e3clK1XdUoKkj4YabFRAYZuRZmw/FBt7cxQIJoDMqsRdbpON85X5UTSKIL+raXYIzqGCk8vtx8lVe1Hs4bI9A2XIqPMck1S6WjU6UeKYzWyvMtHA3pRECgwe6nHQ3joDt1NnaSIPSIOHmfVpmDF3eq/HIXLoGnUBAuonBqu2MauCc1gN3w/ri8QHrphOptRSzSE11O7KbHVzSNJaEHgQj3YLRHaWuiOd79WoCIFJgMBRVo9iOjQ1E24hhxQrNvTE5DpmawjuW686xzbqHOnNETf3UrZKXiVkebInIw3dNJs3NHTGj4ZxKYWUKGS0ZNaQDNDRoP9jMcF0aJXuMZe9XnowTJMnBmnVydI9roeix9ZdhfX8k+sjpw8hqU5C6QSvijL1aBJES2lIeDiAK5RTazivmEiEsLOZTBo0d9IgP465zwLVQ5rZMOqJ4XMPAtf1YF8jkTWLhb57KKsJskawCSQopdjnLKEDIm3hMTfM7NyDUgUQSNHdAlFVAUzVvfYUGqfa1Mp1ZkT6aTk/se/7uV3DpEFJ7NZn72DXksRyxJyVAVSnSz6ZuUMApPGgk8SQZpUExLYpBE5ZEygSkO0VgA5JyLwaQhShclL4GJWssQ3rIlTVzBrMI8ozulCuLtYQR6PHGD2QBCGReNRJIZUVVGmCNpE0BbIGSBEy7se//TFXEnLpw4NeRjeq+ynh9+9Gv54jgVIhq6tCZZZHe0FDLDKz53DU8K3lDBAygscUJHdtqtYNYgDCpBH2PqqIWQCR2/b7j1ETcA9qkhieJpWFcjLm3/pGOlqzwOlKAlmEEt0ZGupmMatrjlb0SaoTAgMGD1kLh+rOwqwJa8XNsEke15EpRVDH+8gfndZFrZWhasU8AvdBc5zK+be+a1lS1MbxIEAgMlNeXslMeHk7NGe72jshCkkTKT6kfKobKc39iRYwCM1m9vMgpFSRhmQoRk5zokR4BxGlnde8peJU8m/dVfbxfsrq+zYFMnLfI2PlqCpxZbe8xhiD3vTBgChaFJHwIRXrM/vSGt3CvZwqG3R7RDIlNCSlzmX0UsJk0oRge9vLHLXjZOr5KDtWn+XPE1si9ogQPg6lYTChZEHz7JruFXCoikkoCUrm45nOa2VfqSC15gYjoY/LQ4YNDYIdL3bEBwYXqs+2Uue36181+iP9ZBRvy/za+rzXMVo4DEniNsuMIxNEN+YA3L1UhKQCQaJCE4834lQNeXXiGhG8Stx2uEnamEo/29V70nnt3Yx/va5l2RuT+jpOxRj+y1vmvTnvWrbmuN2MRS2dCIANEKWaTXl1AaUCSHzpBMzjETTtlig6FYAssJGyTbs9Sz4Qh4d28S7r+byUsnxbVEzux9ZxGutcyTg4R/+YUYhXrmqo+PJWl2UjSXI06d6ySKrIiAIINB082GQKcR8WSjIiKBkaINs2AThp6kUrTYFHb2/XUg6x9dosR/21u/lJOJ2WpLLvAzKc+YF181M3VnaVKpPq5AA5BhGZ5StDBQAEGo9W5XDxaZCSIAg2CobYIAiuWzwkKGZGK0W3BSBDgl71mJcfIYqTGDq5VElkCqu842XwU7GQBCVoTCEFr+JieZcISV8ACflg3KLoOOgqBKThAJaCrgJd7yWQqbiRQXdLNbNZSn8Mn/JDIvM0iCzqS/i0yKwNbmPsrai4CbtEy+eQyJAUZjFHoVQiECBAyXwsII2eg1Nwor4YGKDQpT0VdN93ZROBw+kOqppNrIbt3qBVcB9+GhBTSrQd63lsg9GzokQKliV1ug7VGJQE5WImPBNANGItqwZ6jfdjAVh6YtpqsLld5m7wYFQCaDLvSxDbAXV1yChqYTpoAOYh9YbTyJKzadhyXsSx1fvRfWngbHm45cL2DIIkwxZGMxaRsPzIPrINWCIfTIIJj0Y+rs3SvvpodLqZAG1x3+daVeVFR7+MCTV1691CUZC3PydOY/tIaiPWiBY4jtuPTlv2Iu5lhss5iAwLkGLKS0whE4uehQj3ZvBgywjCmHBvq7433Azbl8UdkwoR6POuMgYoQvHU7T4iDufx/WecSHdVQWsmkSqx6KjTRpAhtk5v0WUAEqFGYDi6kYwEKjDdigz8aJCNDMx2wMzxMSKBi95fGgiPqzd1v/5I6ekZE17vwpQFR79nyon40pBW5jEU1niTWFGTi/DjqoeercAKSMXgdMJpERJo2V1GlLQfC0M2KvtgCa/zcogArAY/tjsF7N3d6/PYXB7VjKZDRsbMe+DPj2o4oe6esvghEvWQkGUxiNrbIvi+uUtrvVbNhsG9ZSupXKi0ZfIGDYSPBdDeZo2d1xAyjbBMQhDAhOZoPoc5VEwqZcQsYfV28fw1cVo1R5VLFbu/loV2Xq/r4LUdB7krlGYHJyLUjYqVychMpK0Er00O+sFwy60VWDMG3Ba+9N5cK0RAnZ/ioIhSkKYjytmyZt9qxcnV2iF9U65XkxYNAW1uH+dYSrBgbeYOZikzFgiINnjiQE18OH4cWv69a7C3lp4XznhzbwL++Dj0CiEYcL6Vqz/mYiUkYeiXO4zHnX5yPp/O8y9XUXHIeVVyn5XGgtEyosRgMRNAgQQDCSBshhb9IDIsPjcUkX08L4Yi++jsa2PYKDEER3/83DXe6aCaqm+XLkEFx4n6dI0yVdPWK3GggcgMIpU0MyYFllJkhmy/6va1mWkEzccAK8LBXgtu+vgdUbCv4yPlhg0JJM7CHNaWt8VvSYHca1g9GKFysqj1iLKaYAHnmzAijVSUBEMgKjKyJGmtQJKgUSx199APIKj0VtiEJyRDDnx0H+3AVoqMKamOj/OyMpCjJyRdxoQYyOTJOrq0JYQ2F6L19w/rRMuJBDKqkZkHmisJ0GQgCfLRCh6gitqbFesAFQKAzA5JEzQTIlA4uhoRLoqR6GW9VzfTTJvT1U8SXFS8kOHnBQnbF0hSJSQJWiJC4cwk0E0lohVV03iAKbENJggoM2ECkA0AZCA0E8zgYpkLvL5mwA2PGuHmCp+efqIAyEMmZqpgqh+3MHWzkaBE7AvJLiYS7JEoMBRo4fkIaAZCGBxEAhIV2jGBJIS9k/i6lwS3kX77/XXsnLdHmeaSyekjccL9pm8tchvBGb+837iNIpkSgfBuERlBVFUnMBFGBT4C7FZ1JNgIhRSlgyCtkABU2IdKmiHUOR6PH/1iWiunchs6jaLmJwx+tPN5u2x0rY+bMp9OQKLIHqOCLhBFMbD3bi4oJT4CcO+KAqSjrJriJsmkyUASkLZW9kqymvzzu9XUPP5BIVklJtxKaJ4wKKW1y/Z6kMrKpYeSTfjs0WK4JGSJuIH9BOFhxXiMbASMgCA1SeDdZJNISR0izRE0Us3tcptd1mQEAcuQDlcE5ITZXZHaLwKyWOc0Ej19+KykMwNkCSsbm5W0ISMPAqCtiJEyJFFuG9a0UxShcKpGko/6+9Fa3oQztBrVQwE4EqebcB19C3MOcwu/nv4zZovoQlIeSAxXZu6nMwOT7OCBugMNEnZLJhESgqsqWlOas1CKpBxZD7/UyV5N0la4u5urnq5PKbSiLT4WVbMf2t2hJJNEUyyiSG8NRAC78VjtVFgNS+Q2AOoe2cz5vl6vUmMWTLZ29h8dG5gI82gF4sMoftpEBDEnPqxmN8/YayMVkSmNhphFjCnkhvFgA4ESWqQFhAYBCKV2c9Zdw5GCQmL/sNebLmQznWvJiLPVYSanDe45hq97Xo8/9WudqNGlDEONKoFNjMFqxXkwWcs7MmUyIOMmkNhuINGUUKgKLVKu5turzCWWGVGc0uakgsNPGwDH0ft8jm2eR67XdipVVVSCKJJOpWzjwXKtqDvEbhFAjAoJjRAWaqlc5QAOBHXoIbD9/W2xOshQNaoOPIUjB459XvZx4HGSFOUFME2F7tS9d/hQxAhKNbOzaSMqVYS8KiVlhRFoVYhpJOzCVrqUN7rUKC71Jip8ElAW+li7jevAg6CgUZlgcs5iVPkZPNAUDICZm8z+YLgWKpDqlhNkvXBUQKcC0M3CZ0DR2YYap4GQqo4nkS4yj/XRm/lUJES5kIjwZlZQOh5IRKm4WWiwQksgsEYchRNkpMI2DEdkTDgWV6KILaGsAosxqE8AgTlSnIx9P+7fukoETS0mM8rSN+7h83EgyMyF4UGg6zZi65aiscVEIZZJGmLsQPoGlnIOKKFSs8pi6fDTB1pUjjEsdPBP1eUAI03eSpBehis3+4GMWmAfKEABCGgUIBVuO6yELZAg2lNHvc97X6mc09OHoL66bjOgp49WZqI4T15+lwUVQZjZHCqVxqwJHTxQLbD3lqBYIpBKSBBgkKw0+ewIqLBH7/9868WPPlHY6yMX/BhaHcTppxVCf1lV51l8HdvM48gWwp3DS86eCIyHKmwCUritNZggYIAggFSwhE16IojZI3+M0vuhi9XvI/rGhhoGPXkMmzBuTIRVjzHOjPhC95HoamV3R3ikbC3tyAaB5qmJbKADhAgU1Tm1tyVoYdhby83b7X4ZRX/3/n2UCXN1nPrJGb5YgblCNf58sY/bOYKaQ0R1MxOwzQcCGGwqtJNsFcNiWwGGzN6S6wzaMIJoEVmjj6A/6tqoBSIlHKf+uriWNqfMYlrNI+fF+DWfg5qlBLuLjMhukg/Ex7YVhlCCiEAqgBMLdEftqVn7IyLerchdp4MWMo5z7A4gcdK57zsWlVLmxLdHtTjPOJLxtttz+mzvgIaAzLB5PBSaSCmB0b4LhIEoCaO0ms6x11rncRw0KB25uZxLei9FGQD8lNny7T3KHBrLufB6Ph999Rozs+W8CNcpjG6lBaHMvoyH2pBScbcrAQATqDFACdiEWbfW/Hphf+RlmEVqSy9UInHiuX98U7LF8nEOe/u2PvS2b/o52/sxLnxouBTtrMrQQHKYfCjwGrPBVFlxYEruLBSNiuM+a21P9+roo60rKqeYCOCnLs6Llkbl/gb/+La02et9xcErtzPzday+IHZLU+QQmwb5UDQDpYlKwNoJGTbvBQci2CDu4NudQzLXBdZiK9GhOP2x/+azGdLcl2+FCzrXzYXeZsQ63l7HVLVR3hhkHxuCDSB888Iv6gzA0HQm6lZiA2GJtYbPHmz+ym//PgumN2G2q0mo4/Tz7X2XVhTtdgC2XgPT2X/KN824HRF43POw0/tEllhNFk2zCmYCgG9P+EVVwca8hoRNKqjhsUzF1m0zCWeO6NiHlu93XYcU0TLmrhp4Am1pbfU2k5E5bEEUt+9nX3x9mK3s83OrRs3LC0oKNBoGayaptab2fmsUhFClZtYaMaYbUCnawxACojYKLVQavWfyPPr+pHipmJoknkLXvSHKt5ZaYHDXkzHPnBtsD398PsU6p3w2giDEbpJUzQo0a2ybb0rIgCgiqam40CZoBHAEiASEDd3iYRhk6tXXcfATfJynhlQLfQJYlrc1WivXM/j+l+Ni18FMqUZmsMbnsERePkgGyOyO3VApGTETo0m+ISEJZ4SkZAThl+1rL3GryCIC6UNAOXodW/q8dvMSkSIFgtWs6ukr13MpRhM7X5eP5Ty8KciUm17s06XIhDsEMpjgPtzMGgGKLqw7e2+8nQEBImEDs1BBDwi3jXTvILmXJwfZRlVyD+u8nh9E7kKUpMg5fBCn36679NKmF7ZlsXgvcsvi0DLr+33jXiiaITjFtDj249eeWefUboQsCbTNNwMEQpAGkCoEpgj2zrAZGsrnqv7e1Y01CWt0/e2WU1w6mYjd06c+AddA23x1ixb7MkU5kqRzP+r7CcvUxQzz4ZG2m2WC86riVO8EcwOQxCffCgIgABosOAHZLm4a4w47VY3TbCNgT8XgtU8M5lCB16lTBiLz9PF9zaybRltiv6qopCqzpXV7nJaZZCkxlMq1sBb6yiqAjJusJQRJdOwfSPiLCoifSCrdGGzS3l0rdBvS4GNhQwT00Utis+rA6pIXgwslMDY8gff3fVPvZZbzG1SndCSU6VhVKQBVVE/EgSBWZu1WyKpN5VwhaQDxwR/AL4vBTycNTds8NiNDaSbF0IlMptONjTOT3sY3fsTsSgVV8BTKDJ0ob6OcQ82Ara+uj7WNQgJEOdC9MixoYSB30Cxla84izG4o7E0CIPHL5k9Qxdwl+Ti8N2pK9kjcRKKjIrYlHwemKiBZ9XyGZaceRzc+BbjX9wYuyxSxYunbg7ln+NaIAOQFkAwwM1ZwKN2OdLBSKWyLhLdNA0CZv6ifmLtIdEDlckf3JBEUNhU6TgC2uK1Ceg1e5/zq87v/maO3Zv4k+G+LktAwm1A7hsQHKt/GPRCkPElKUCZt5eUiDwoAFBUIELBZ2f0FAL4JmiQoGii66hZd99Bk+YCuKhmhjZw66KvX+dsa/7/i51G1LLw/BedvO4amjim1ej/KYwCN3H/Zt5keIgstsjJth9zRnGqCU3ODFXgnMNpPIJL9RrwEBhLoaG4QAKrcGHajtqkEKLiAmO5jfZ/zPDz1jCi9C04/337h0C2rLV7r/X5JtVnb7c1u7znSubJLzSAjMljzyiAqiVGBBIibUV0fl6TzFpvgW1CvqaiCwHNXNwER2QkcbtTEiHefZbKh4yy5SwHfVVsKnkIvSnSY+mp+245X7oyPVxwQc9kIH4RFlpCRqnavWauyaYDKARkwbGstxYEdgEDCP1X4F7HndY9ZK9I9hIkQgmIMr61ZoU0O6I7AO/fpfx1JP86h+jalPgFH4lB2d7fp1N4L9f1ddvx8pFWpZy2QIBFVZCZjzlnFzSJogp3dVqiJkFDGHVsTIiYQmT+N+PMnC1c0sWpmoKTYAFtSrRe3bW7BEUwHK/NZv/Ef/7hqggI9sJ+1y8nDVkVmDjC7lpBRwt9Rx6/vLzjjgEMhMFBAMTPCAicjhN1RNt1NT6HKBFKqSJW4ZvUmEP4MAEFA8E+W9bn27xZrVSkFIiObZLLudWHhaAstsAFEwF2z/uNjN6oxxSXt3TqeQHcIOcDQ9BDYvL3bbaV9HOP9o9jDjkQJKZFMJjvGpBy6yQY2xtQg6Za05FRgYK1rEzT+hMKflfVZ2d9DRQtgCGDiDQE17ReI9gluYzOK8CrqPzgGkMlJ0/TgUwCYcfFa7SyJcPiz/uYNsa+Jkh3z8hVSgchUZlVHKVXlQJrd7KqMCVCRDDkkguj20THxJ2SL/DPAo7ljzk0AgkFXWK8zh9iFplgtRkQ7gGqePt7v5dW5cD1jWCeexjCds6e26SyBY5UdB+qq9DNwM3mDLCIBZLRFDWjQHZgA6NAEUmD8DEMiCSdITP48gMGfPmEqNbMqI6SU3dGpey1Y2VegCA2lGJKJXsyv/3+twhNHzqub58ATqQ4B0OtcmlN//v/f777682HB9vVxu9VnCSKATIGmBHQz2DBCEA7MAG7apgECEFA1Knjz5wV/Rt0gCqtWULVIhRTmvVay6pn9jMq0ZuuTKyD+9lx/vD9/PdHH3LyZJs2eCjhcAYx+hOVRM1d0jUSehpLtdQ5qVARAmm1r3E2aJnPmMgWCIIwcV0I0kTAho1kVPH8Wvwj4J8Gc3fdMqKAkJVPJTOw6z919ICaWzH3/kY52X1j9P2pvKZczaplh48n4ac1eawWQoJcVurM38HlBQwySiAgxhkG0bQtGwwzSBAWT3S1AYAgCQhX2/pMg+JM6c6pOm6wSIt3nQglj1iofEoLuIXQ951S98srvT095ne+GWDEJsaQ+LYCo47OJvj/Hap9j+hgaFUGBgLCyjQS+DhDemyJRtUMHUAV7N4DGrTABpGAT/EmTTZA/Ev4kej7/XeVOVbGBec2qqRq0K1kJnMFzi7i6XoVv/z6uv71fR2sNl+IDZbmAmv7E/DQ5p0d3tVfXlAvIWGhmAG6D9JM1THabUNqkBFII5G2SswSQdMIZLnHzB6IT6SfxA9HUsfkTkPOs1FJmnMA+X4gU7h0AayHOal5ZuDr3wdeL17++f4NsRpjC8KPbdDzZsbOO9RyezXzEVdTNnYTRqWaR1UjA9gMNoABmkAoQ6O2QQBQEgC0tZXQcX2jWmX3DCFnB3KNjhz+ie4rJGikVGOFSYntToKprppqLqapDx44jFTcRBmPpqrjnn0D4qEh2L9QxsrrJhrMlDSQAi9k1EgojzKyAVQWsQEiAYMA7CdgpGhEiSGEEXl+sEKV7VZpDTQ2JkGDmvl+/LQOjCEqWxF2Bu524S9ThwoCj+bYpzQtH4PdjZURzHmvSXYXHTE3SWLtIaLqLcsVWM9okXGXa5VBlwhbDkkxIjEAmxQTBjUZC0wEgQWEAgfFFYArM1Fpl8cDSRGwq5n2e6wziNSqlsW5hP2toCAFVUKgSBu3i20VB5RyXTrFAUbeanGt/PihVmbaoiBQyiNpj9doN0ZxwkmxCRWUgEiuSBYBABmhR7H1kAHRoRiIckkmBbWcUqDCJSuh8nhBiFkufC60KtLBkI4kTeoCakYg4HYCa1fuWm0ZMQCfupUV4ehGdJL0elLedW7Tdpw/hSLK9zbusy6oApznTBVJkRAREqIrMTAoZ+iKFuEMGRXOTh2EmSCk0MIiAiaa+nfAMTxmrJCdCwMYtV64tZPbOUkFaMkA3J7UqK8wnHHAhbWY3hBlx1k4eU40y6eV9EswUcL2+tVmC0wJmhHkhUiAYBnonAFEQimB1Uwp4dAAm8mEhbQcp5qZTa8TOGmrOKajWkpKKmxmFdC6W7vQR0OgMSDOBVIWimNwJBKfmYPMBcW7DjI0qpXzNQyJ9GpUqdXCKKe18nUtcmziMKDMaMBKAZCFvJCqlYmarmohg74MmQel51SBo1iSqAPO6JQqDkopQkSrcC/tD91KbTRVQI8gE1quCJtOoy+0YbVHtQkIm4Ioyx+igK1hcmhMoO48IcFHG+BlGBGmwddeDZ+gMKudSEAlkRicCpEQSRWYkmiWyScuXYTNlIonkGJQCrWSUkQlFIydEqgo8Zt1tR9Adz1JiUfeqSTMhkOOWpVh3UwpM3Uzds6r41ALtlBSkiAedUBIkrQDqS5FbZfZro4vsk2FALGN1BmQsgmRGBjNY1QYRgG04Bcs9TGiAEVLrHCYQTUWCvuCU4dzICooRc96RGMxdWrrOs/auNVLoagpCN5N0wrl5dohGlKzqDB66M0ITBrcchfeLKlx9xvEY63QimYEiM0kgSDIZDDN0qREbDo0wTTFdIEKBAm/NCpiAMSsJggpAe9dS6lyIwHWrUglKtyaZ+/aTnwfYO7bjWIoMDAsTFSvRt0PoiCiDB99YxUV1GkS37R7tbLIdo944F8NgWqCbdqQ6AiwCTMYub5oMwWYVbBtVYUmJANp5iQAEE7DGFmIE4ZF1pGaAaJ3nKYkTMTxXi5d08O9jwZbp3bMKPTVFK5sR3zevcnjPiQdPcABw7bZ674phYdJrpscMTc0EMBrdCSqSBBAGAk02gZDdFgk6SeVOJDAE9hRIAKSRwEYiAiNqiVhrjbJen+teM3EzWb4cHK81GSIJ8ziO3x9YIzEcIMTzh2uXXHj8dMenruoKzYG5IMWH1ng/rNzD0LH6GvYCU8rgl5WUwhAwuYmQRLBuGwaBFBpfukWGDBjmSy2lMuTWWatm1iksVV05l3sPej+Lv0Ny67OBcgwSTugYrml6DDwDCcAdnxchAFeK0MnuZfUamloWJMGwREIOQN4ltQqIzcAETCmOwoBkUHfJUQjAJmBDRBSUEnYGMpSsmRdnVlRsxYWr6rric7MDUy+u/TbHDMku5tslfMiz46eHwNQWFssK63E7DnUrXpBKgqCCyn0WCJhuIoA5n6cbIgkCCFfdThAoaMLkZpWQ0FHD9x0DoJIAy3ewthOYNPA6cS5WKXW7P7we49z6MTyPflM8D0kSf7CMQ8paYq59SzHf3t6/X54JJETBVKzSeV1EVDY2JCque5WjAA6YBASCBIHJbRsJHZbUQc9ngDBJSHofqfMchWn4OOacNRLOHOPPt5G16mw69fKzzOzPBBB/TB+HL1imem4fufa32moqA2JQTG9KlPeIFE2se6ZSa4whDYQCVbmYooJwdR8bYbEdzkpHgyoS0q0Gi75UI/tX7FQ3Z4gYopLj8jgcziZZQn6u4eLPBdD/CAA0xbKUrDaPrBrejiRJJbqrWBDYmSasWlVRIiqNBBUiVVx3RFQqgHgohImQhEjhcCVRCqRKrMVj8/cDircV78k6sj/umwLcQ8X9vlE8ng9/7EypJDuHa8blE1JJWSTVXYSXFJDd9Cw1ETOKKaWKrfD+LMBFI0yJSUyUu5sxDdt1J0AgQKUcPL7fRxeKVSWl1Bz3i5sDk6NnXirgSjx3e4ebT3cOP8Z1halFgmC7mDVmh7FsElHBBJjc5+Ezek271rdB6E0wIDohTSCHuYkfTKAEyRRxavNX1latQOn2uaXU2+ZzgU7fZIgKPvVnD7xnzuZ7+kqeThQJkmhml1OKVSKNWsWEQoB1k5j1fmbCEwwpBAbkdryBALuNCrallS4GCKTcxr+4orMMjCSGOraHF5GMmOmA8jPPYh/VC8sjHgc0EAJE8dAYRVJUy879KlPrBoBzDs/rJNYJmJTIAEzobaAhxN5mgEQjSAWiAkiF5wEkr2Efn2cQFhxDyniFuuDT55T0YT2+jef44y92ORMRSoRXtXqoKEX3KynqzkQ3Eq1kCNAM16lr02LL5HZTMGEy1RmpCJUITYMW853s/f6+qrytYSux6H3rgDvM8cxOq/TJ5HFLJYUVGWR2s5CMlTlfcCnas6Q5K0JN7C66S1U5nGW2ATZhc1P0qntJDFrSScNBX9+PvPqY834/P82oBVaKlW0LgPua+syi2e3nuv3Cu/b3PZiR6xDCqHUsW0ZXCObYzFpar4o5MkLEUBFr9i5xIymCTWpSd9Wr3Amg+vws8+6mfVRq4z5v9Rpd7Qo4pRf1iB31uYW6r48Vq4+PkCLtlUOjI7GOIDP2xQYItFPKtxvpi3eRZjcxSFSmJgKChFql1HtNgU6wNKm7JqE+xy37tbQEBW0T7Qekci5ruCj8mYWM4+ex5c+4rhpz/Wz3O0nodaCa8YoNaMkCmdcSQqDgHJvUCsIA0OcrHS1qqtS5teYmgtzVZt277qIJn8X3IRQTTbqPx7Bhy/u1iKjrcwtAnPPXNx/JuOpnfzIEM8AgrqU2MXelBkMuMaSS8rEJSEnIzKwVQrNgrWj1mtwFgVrWmlfm5Tw/4tvQINE5zIzwPqRz8RkuRxF5huFDtczw8/vj/CPvFcEyK1qAa8Stykir1l1pB9FNuLvqi8rutUqqTeCGhUlF4EykDb3kvj7/OTf3963vWdec1vnbJz8BMkOwqoF6gw08x+1XPOLttb/tL/mY7GagMyyaMylwU/e6z3M5COb1uvdR654VwiEmaR+IvaMBVSO+FtZ99+8o0pmz5nmc2k9nvb+b//7j22+/3WtItmY+zTvgCn2OIcN7/+NbvL1tz6efzQUXksjjXFNRrvrtLkb3a/B6/zu/l12pJWHgrNpqEIbuCXl+1uHOYv12fGeVfvs89Oqn554S3j//+dK9MJRmghz3be6Pw10Vz/O0dYRW+PW3/ozi7SbCPez9vUatlNZ988KaP15//+MmjspHybXmPP0dmln3RbfXWSHXP9d3vub1+ndfV+v843Pd7597X64R/fpW//03fmRAOw70+48h1aW7Es+1TIBQXd+bZd9E6UDWQ3O8TXMFpxt49HbcC8AlrNgxfE5mTvrjIXeuu3mOA9ToP/+4fK+9YmeOfNxChypXes8p9yo4KqiGyIGeBmA8DIA/o/hlcIfBIVEvsf0+1Jc5ht83t5RzGJNlumyvxuWqzryd30f032ckNei/3w451/cdcmwHw1/749feSnGh//rapzli1q0/KrUem8xaJ93TgZmCzyqe12uIfxEYUKjj8utFN4wwpeTho63HmDSnm/cjxeZ1jhEa7VEWlWNLyXo7at2+/XXj/XDq6I+fe5uTUxllbLnVkoJty0vWAYfb5kW0OqACw/PcE19OgwLQXo/7hrS9VynqIc6S7hJwdY2z1e04z44VGa/rDKt35HErd7Xl7fb4379Gc8lqoZ4oKTFdIWO79ZoTfmRQQUg0vSkATzzXBX8IBJ/2nrkRkmnkUvtoc4/DaaqpYmVp3LrOdlxqXGWyQ7bUoXLvWXP4w+cICx8KcXPXWfI+onckiYQhjqApJobgRen46RRJ7/sybrEMt/n7mMNnkfuD5bfrHvqQZdQhS7vv1Dujdmi9VH30GSIjQlphiofCprMjBxs0PN1mDnZRnxF6vCy+XBHeyqy5cor8+D01NMuMsq6KAyt7LH6vdTKW4yLb7yqYejtGLWfNCLMyLd1UMbfephwMqqaTJLSymonNlJeKtV1GMNbrJR3d+mZFLN7mETNHFnPUigzj7Wjoh+I4/MpM6WllYTkTaZadheiHl9nVguqu7sKAZisQj/FSKb9cN1e1s9QO34x0scLV1VMz6IB20SMIuMPx6Yho4YjSss+zq1kSRgIi6lROMYclzHr3qm/b5nix/pePijHW2PJ+O9ZlKa1ussCRTgKOT7Uf+GL3sHbeY+RjxFyZUiACVRorjBrTDg/yE+pI2MvF1/PEGhyOrDMaDgGQqWZu+FL/MsCchfesHWQr3kXVAwPuBCAsuUlACEl16U68XFnOS4tUZrE4bjq8tJmDBtC/5A9WGxJjVB1ail665QPXZuSAhava6Kl0FSFeupuV1ekiBSm4+aJt9kkyhuJP6OphdYhmx5s9viejRMQsZVOmqDzcU2ji+EK+UOrr+jY61ZoqAyJso3Jtm+BPra4J6DjEeUuclxyT01z89mM7HHBXU3wh8VLNuTSPsnQFp7mIzKhh/qcTBQDa+PMt1xgTRy5Buo7tECE+NfgXvGDnOotErYDN5o6hDXfiK/wJkaFcfLBNc4iL94PEpyxF/OVj6OkWfShjtuw+BRPja/i8Ag7tVuYeEZoDxwM/yXR7AUEHshUBDbB0u5vYCv9qPi8a5m3qUV2O8VNwxUvYXWeBI4oPMCI7mPjqKfQ6xjbK2PDSpgmO4bqUodXXCcD96zOje58iAE1eWOYBF6iX42EzFH87w8rSZgPY1rLly8pDMM3hAir+tjKmGaq8W2fjeGFZqFqQkMXxlcfi8jlbpmnq3d+tUoa/rBZ+EgZwqsO/Ilorop+ZVyolt2Nc5ftGvKwDcA1QXM4L+/iKWvPU8E9okuoqokdVvLQThe4GMy5lVNevRyU1JhSAi8AoChl4ebvPmRKzmfeyzlv6V+PqgNlnuiuoeKmLGmOeQ+foJTr8awFIV/x0Cl7srtCh0Ra7qzfH10s43H/qpe+ETYttDvxdrTjCP8o4viKSf6cAwqTsmV/R3zkSZFyIrzfgGit6xNcbIPmrCV9xrW87vurGh+Hrbu74X/z/V/9/9QVWUDgg4gAAABAZAJ0BKkABQAE+nU6kTiWkI6IgKACwE4lpbuF3YRtAB6IBXcvFych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ9YAAP77ZQAAAAAAAAAAAAAAAAA=)";
  const INK_REACH = 2.7; // 墨团多大才盖满：浓墨的半径约是图的 0.2，再往外是洇开的淡边
  const stepOf = (el) => Math.max(0, Math.round(+el.closest("[data-step]")?.dataset.step || 0));
  function parseAnims(el) {
    return el.dataset.anim.split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
      const a = { kind: null, dir: null, at: 0, dur: null };
      for (const tok of s.split(/\s+/)) {
        if (tok in VECTOR) a.dir = tok;
        else if (tok.startsWith("@")) a.at = +tok.slice(1);
        else if (/^\d*\.?\d+s$/.test(tok)) a.dur = +tok.slice(0, -1);
        else a.kind = tok;
      }
      if (!(a.kind in ANIM_DUR) || !Number.isFinite(a.at)) {
        console.error(`[orca-transition-skill] data-anim 读不懂：「${s}」，可选：${Object.keys(ANIM_DUR).join(" / ")}，写成「效果 方向 时长 @开始」`);
        return null;
      }
      a.dur ??= ANIM_DUR[a.kind];
      a.dir ??= ANIM_DIR[a.kind] ?? null;
      // 拖影最后一份副本落地后还要淡掉
      a.len = a.dur + (a.kind === "trail" ? TRAIL.length * TRAIL_LAG + 0.25 : 0);
      return a;
    }).filter(Boolean);
  }
  // 拖影、擦亮要的副本。用 div 而不是克隆原标签：reveal 的 auto-animate 会按文字配对没写 data-id 的 p / h1，
  // 同样文字的副本会被当成下一页的配对对象
  function overlayOf(el, cls) {
    const c = document.createElement("div");
    c.className = `${el.className} ${cls}`;
    c.setAttribute("style", el.getAttribute("style") || "");
    c.setAttribute("aria-hidden", "true");
    c.innerHTML = el.innerHTML;
    return c;
  }
  function animTween(tl, el, a, at, extras) {
    const d = a.dur;
    const [vx, vy] = VECTOR[a.dir] ?? [0, 0];
    switch (a.kind) {
      case "fade":
        tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: d, ease: "power1.out" }, at);
        break;
      case "rise":
        tl.fromTo(el, { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: d, ease: "power2.out" }, at);
        break;
      case "zoom":
        tl.fromTo(el, { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: d, ease: "back.out(1.6)" }, at);
        break;
      case "fly":
        // 挪一整个画布宽 / 高：元素在画布里哪都行，起点一定在画外
        tl.fromTo(el, { x: vx * W, y: vy * H }, { x: 0, y: 0, duration: d, ease: "power3.out" }, at);
        break;
      case "wipe": {
        // inset(上 右 下 左)：从左边擦出来 = 先把右边整个裁掉，再放开
        const side = { left: 1, right: 3, up: 2, down: 0 }[a.dir];
        const from = [0, 0, 0, 0].map((v, i) => (i === side ? 100 : 0));
        const inset = (v) => `inset(${v.map((n) => `${n}%`).join(" ")})`;
        tl.fromTo(el, { clipPath: inset(from) }, { clipPath: inset([0, 0, 0, 0]), duration: d, ease: "power2.inOut" }, at);
        break;
      }
      case "trail": {
        tl.fromTo(el, { x: vx * W, y: vy * H }, { x: 0, y: 0, duration: d, ease: "power3.out" }, at);
        TRAIL.forEach((alpha, i) => {
          const c = extras.trail[i];
          const t = at + (i + 1) * TRAIL_LAG;
          tl.fromTo(c, { x: vx * W, y: vy * H, autoAlpha: alpha }, { x: 0, y: 0, duration: d, ease: "power3.out" }, t)
            .to(c, { autoAlpha: 0, duration: 0.25, ease: "power1.out" }, t + d);
        });
        break;
      }
      case "shine": {
        // 一道斜着的高光从左扫到右：副本的字透明，背景渐变按字形裁出来（tokens.css .st-shine）
        // 光带只扫字本身：文本框常常比字宽得多（整行居中的大标题），按框扫的话大半时间扫在空白里
        const c = extras.shine;
        const [x0, x1] = extras.textSpan;
        tl.set(c, { autoAlpha: 1 }, at)
          .fromTo(c, { backgroundPositionX: `${x0 - SHINE_BAND}px` }, { backgroundPositionX: `${x1}px`, duration: d, ease: "power1.inOut" }, at)
          .set(c, { autoAlpha: 0 }, at + d);
        break;
      }
      case "out":
        tl.fromTo(el, { autoAlpha: 1 }, { autoAlpha: 0, duration: d, ease: "power1.in", immediateRender: false }, at);
        break;
      case "spin":
        // PowerPoint「回旋」：绕自己的中心逆时针转一整圈，同时从 0 长到原大。
        // 绕的是元素框的中心 —— 一组扇形要绕圆心转，就把它们编进一个 .s-group，组的框以圆心为中心
        tl.fromTo(el, { autoAlpha: 0, scale: 0, rotation: 360 }, { autoAlpha: 1, scale: 1, rotation: 0, duration: d, ease: "power2.out" }, at);
        break;
      case "ink": {
        // 墨团的中心落在「从哪边来」那条边的正中，不写方向就在元素中心；写了 data-pivot="x y"（px，元素内）就从那一点洇起。
        // 墨团的边长从 0 长到 起点到最远角的距离 × INK_REACH，洇到最后浓墨盖满整个元素
        const w = el.offsetWidth, h = el.offsetHeight;
        const [px, py] = el.dataset.pivot ? el.dataset.pivot.trim().split(/[\s,]+/).map(Number) : [];
        const ox = Number.isFinite(px) ? px : w * (0.5 + vx * 0.5);
        const oy = Number.isFinite(py) ? py : h * (0.5 + vy * 0.5);
        const reach = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy)) * 2 * INK_REACH;
        const size = "calc(var(--ink) * 1px)";
        const at2 = (o) => `calc(${o}px - var(--ink) * 0.5px)`;
        for (const pre of ["-webkit-mask", "mask"]) {
          el.style.setProperty(`${pre}-image`, INK_BLOT);
          el.style.setProperty(`${pre}-repeat`, "no-repeat");
          el.style.setProperty(`${pre}-size`, `${size} ${size}`);
          el.style.setProperty(`${pre}-position`, `${at2(ox)} ${at2(oy)}`);
        }
        tl.fromTo(el, { "--ink": 0 }, { "--ink": reach, duration: d, ease: "power1.inOut" }, at);
        break;
      }
      case "emerge":
        // 飞入 + 遮罩：元素从自己的底边下面升上来，底边以下一直看不见（PowerPoint 里压一块和底色一样的矩形）。
        // 往下挪了几成，底下就裁掉几成，两者同一条缓动，看得见的部分底边钉在原处
        tl.fromTo(el, { yPercent: 100, clipPath: "inset(0% 0% 100% 0%)" }, { yPercent: 0, clipPath: "inset(0% 0% 0% 0%)", duration: d, ease: "power3.out" }, at);
        break;
    }
  }
  // 这一页有哪些页内动画、每一步多长。只读 DOM，不改：buildsFor 拿它建时间线，__orcaBuilds 拿它给宿主看
  function collectBuilds(slide) {
    // 转场时克隆进来的上一页（ghost）里也有 data-path 的元素，它们停在克隆那一刻的姿态，不该再动
    const own = (sel) => [...slide.querySelectorAll(sel)].filter((el) => !el.closest(".st-ghost, .st-ghost-el"));
    const movers = own("[data-path]").map((el) => {
      const keys = parseKeys(el.dataset.path);
      if (!keys.length) {
        console.error(`[orca-transition-skill] data-path 读不出关键帧：「${el.dataset.path}」，写成 "t x y a; t x y a"`);
        return null;
      }
      return { el, keys, step: stepOf(el) };
    }).filter(Boolean);
    const lights = movers.filter((m) => m.el.dataset.light).map((m) => ({
      m,
      key: m.el.dataset.light,
      spread: Math.tan(((+m.el.dataset.lightSpread || 13) * Math.PI) / 180),
      w: (+m.el.dataset.lightWidth || 0) / 2,
      on: +m.el.dataset.lightOn || 0,
      grow: Math.max(0, +m.el.dataset.lightGrow || 0),
    }));
    const lit = own("[data-lit]");
    const spots = own("[data-light-spot]");
    const anims = own("[data-anim]").map((el) => ({ el, step: stepOf(el), list: parseAnims(el) })).filter((x) => x.list.length);
    if (!movers.length && !lit.length && !spots.length && !anims.length) return null;

    // 每一步多长。第 0 步总是有（可以是 0 秒），这样「进页先停住，点一下才出来」也成立
    const len = new Map([[0, 0]]);
    const bump = (s, t) => len.set(s, Math.max(len.get(s) ?? 0, t));
    for (const m of movers) bump(m.step, m.keys[m.keys.length - 1][0]);
    for (const l of lights) bump(l.m.step, l.on + l.grow);
    for (const x of anims) for (const a of x.list) bump(x.step, a.at + a.len);
    const steps = [...len.keys()].sort((p, q) => p - q);
    return { movers, lights, lit, spots, anims, len, steps };
  }
  function buildsFor(slide) {
    if (!slide) return null;
    for (const c of slide.querySelectorAll(".st-trail, .st-shine")) c.remove();
    const found = collectBuilds(slide);
    if (!found) return null;
    const { movers, lights, lit, spots, anims, len, steps } = found;
    for (const m of movers) {
      const el = m.el;
      const [px, py] = el.dataset.pivot ? el.dataset.pivot.trim().split(/[\s,]+/).map(Number) : [];
      const pivot = [Number.isFinite(px) ? px : el.offsetWidth / 2, Number.isFinite(py) ? py : el.offsetHeight / 2];
      // 枢轴点、transform 都写成 important，transition 关掉：共享元素页上，reveal 给配上对的元素挂一条样式
      // （transform-origin: top left、transform、transition 都带 !important），转场放完也不撤。不压过它，
      // 写了 data-id 的元素再写 data-path 就会绕左上角转、钉在原地，或者每一帧都慢半拍地追
      el.style.setProperty("transform-origin", `${pivot[0]}px ${pivot[1]}px`, "important");
      el.style.setProperty("transition", "none", "important");
      m.rest = [el.offsetLeft + pivot[0], el.offsetTop + pivot[1]];
      m.pose = null;
    }
    for (const el of spots) {
      if (el.parentElement !== slide) console.warn(`[orca-transition-skill] data-light-spot="${el.dataset.lightSpot}" 要写在页面的直接子元素上，落点按画布坐标算`);
      if (!lights.some((l) => l.key === el.dataset.lightSpot)) console.warn(`[orca-transition-skill] data-light-spot="${el.dataset.lightSpot}" 找不到同键的 data-light（光源要写 data-path）`);
      // 同 data-path 的元素：共享元素页上 reveal 的 !important 样式要压过去，transition 关掉
      el.style.setProperty("transition", "none", "important");
    }
    for (const l of lights) {
      if (l.m.el.parentElement !== slide) console.warn(`[orca-transition-skill] data-light="${l.key}" 要写在页面的直接子元素上，光束按画布坐标算`);
    }
    for (const x of anims) {
      if (x.el.dataset.path) console.warn(`[orca-transition-skill] 同一个元素别同时写 data-path 和 data-anim，两个都改 transform，后写的会盖掉前面的`);
    }

    // 每一步从第几秒开始
    const start = new Map();
    let total = 0;
    steps.forEach((s, i) => {
      if (i) total += CAPTURE ? STEP_GAP : 0;
      start.set(s, total);
      total += len.get(s);
    });
    const stops = steps.map((s) => start.get(s) + len.get(s));

    const apply = (t) => {
      for (const m of movers) {
        const [x, y, a] = (m.pose = poseAt(m.keys, t - start.get(m.step)));
        m.el.style.setProperty("transform", `translate(${x - m.rest[0]}px, ${y - m.rest[1]}px) rotate(${a}deg)`, "important");
      }
      for (const el of lit) {
        const l = lights.find((q) => q.key === el.dataset.lit);
        const lit = l && t - start.get(l.m.step) - l.on;
        if (!l || lit < 0) { el.style.clipPath = "polygon(0 0, 0 0, 0 0)"; continue; }
        const [x, y, a] = l.m.pose;
        const r = (a * Math.PI) / 180, dx = Math.sin(r), dy = -Math.cos(r), nx = Math.cos(r), ny = Math.sin(r);
        const ox = el.offsetLeft, oy = el.offsetTop;
        // 长出来：光束的长度从 0 涨到「两条边都射出这一层」为止，之后才放到 LIGHT_L。
        // 只涨到出层为止，是为了让整段时间都花在看得见的那一截上 —— 涨到 LIGHT_L 的话，光在一半时间里就落了地
        let len = LIGHT_L;
        if (lit < l.grow) {
          const reach = Math.max(...[-1, 1].map((s) => {
            const ex = dx + nx * s * l.spread, ey = dy + ny * s * l.spread; // 这条边每沿光轴走 1px 走多远
            const sx = x + nx * s * l.w - ox, sy = y + ny * s * l.w - oy;   // 这条边的起点（层坐标）
            const exit = (p, v, size) => (v > 0 ? (size - p) / v : v < 0 ? -p / v : Infinity);
            return Math.max(0, Math.min(exit(sx, ex, el.offsetWidth), exit(sy, ey, el.offsetHeight)));
          }));
          const u = lit / l.grow;
          len = Math.min(LIGHT_L, reach) * (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2); // power2.inOut
        }
        l.len = len;
        const far = l.w + len * l.spread;
        const pt = (along, side) => `${(x + dx * along + nx * side - ox).toFixed(1)}px ${(y + dy * along + ny * side - oy).toFixed(1)}px`;
        el.style.clipPath = `polygon(${pt(0, -l.w)}, ${pt(0, l.w)}, ${pt(len, far)}, ${pt(len, -far)})`;
      }
      for (const el of spots) {
        const l = lights.find((q) => q.key === el.dataset.lightSpot);
        const on = l && t - start.get(l.m.step) - l.on;
        const r = l && (l.m.pose[2] * Math.PI) / 180;
        const cx = el.offsetLeft + el.offsetWidth / 2, cy = el.offsetTop + el.offsetHeight / 2;
        const dy = l ? -Math.cos(r) : 0;
        if (!l || on < 0 || dy <= 1e-3) { el.style.setProperty("opacity", "0", "important"); continue; }
        const [x, y] = l.m.pose;
        const far = (cy - y) / dy; // 沿光轴走多远落到这条水平线上
        // 光柱还在往外长：长到地面才亮，最后一成的路程里淡进来。没有被照的层量长度时，按同一条曲线涨到地面
        let len = l.len;
        if (on >= l.grow) len = LIGHT_L;
        else if (len === undefined) { const u = on / l.grow; len = far * 1.1 * (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2); }
        const alpha = len >= LIGHT_L ? 1 : Math.max(0, Math.min(1, (len - far * 0.9) / (far * 0.1)));
        el.style.setProperty("opacity", String(alpha), "important");
        el.style.setProperty("transform", `translateX(${x + Math.sin(r) * far - cx}px)`, "important");
      }
    };
    const tl = gsap.timeline({ paused: true });
    if (movers.length || lit.length || spots.length) {
      apply(0);
      const clock = { t: 0 };
      tl.to(clock, { t: total, duration: Math.max(total, 0.001), ease: "none", onUpdate: () => apply(clock.t) }, 0);
    }
    // 副本先全部建好再挂动画：fromTo 一挂上就把元素摆到起点，之后再克隆会把起点姿态也抄过去
    for (const x of anims) {
      x.extras = {};
      if (x.list.some((a) => a.kind === "trail")) {
        x.extras.trail = TRAIL.map(() => {
          const c = overlayOf(x.el, "st-trail");
          x.el.before(c); // 压在原件下面：原件领头，副本跟在后面
          return c;
        });
      }
      if (x.list.some((a) => a.kind === "shine")) {
        // 字在元素里从哪到哪（元素自身坐标，不受 reveal 缩放影响）
        const range = document.createRange();
        range.selectNodeContents(x.el);
        const box = x.el.getBoundingClientRect(), txt = range.getBoundingClientRect();
        const k = x.el.offsetWidth / (box.width || 1);
        x.extras.textSpan = txt.width ? [(txt.left - box.left) * k, (txt.right - box.left) * k] : [0, x.el.offsetWidth];
        x.extras.shine = overlayOf(x.el, "st-shine");
        x.el.after(x.extras.shine);
        gsap.set(x.extras.shine, { autoAlpha: 0 });
      }
    }
    for (const x of anims) for (const a of x.list) animTween(tl, x.el, a, start.get(x.step) + a.at, x.extras);
    tl.call(() => {}, null, total);
    tl.data = { stops };
    return tl;
  }
  // ───────── 页面里的视频 ─────────
  // 放映模式：翻到这一页从头播，离开就停。
  // 录制模式：全部暂停，由 __capture.seek 按毫秒设 currentTime —— 和动画一样不靠真实时间。
  // 上一页视频的淡出克隆体不算这一页的视频：不跟着播，不算进停留时长
  const videosOf = (slide) => [...slide.querySelectorAll("video")].filter((v) => !v.closest(".st-ghost, .st-ghost-el"));
  function prepareVideos(slides = allSlides()) {
    for (const v of within(slides, "video")) {
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.pause();
    }
  }
  function playVideos(slide, delay) {
    for (const v of document.querySelectorAll(".reveal .slides video")) {
      if (!slide.contains(v)) { v.pause(); v.currentTime = 0; }
    }
    if (CAPTURE) return;
    for (const v of videosOf(slide)) {
      v.currentTime = 0;
      if (delay > 0) gsap.delayedCall(delay, () => v.play().catch(() => {}));
      else v.play().catch(() => {});
    }
  }
  // seek 到某一刻后要等浏览器真的解出那一帧，否则截图拍到的是上一帧
  const seekVideo = (v, t) =>
    new Promise((done) => {
      const target = Math.max(0, Math.min(t, (v.duration || 0) - 1e-3));
      if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2) return done();
      v.addEventListener("seeked", () => done(), { once: true });
      v.currentTime = target;
    });

  function stopScene() {
    sceneCall?.kill();
    sceneCall = null;
    stepTween?.kill();
    stepTween = null;
    stepAt = -1;
    scene?.progress(1).pause();
    scene = null;
    // 拖影、擦亮的副本放完就是透明的，留着没用，还可能被下一页的 auto-animate 当成配对对象
    for (const c of document.querySelectorAll(".reveal .slides .st-trail, .reveal .slides .st-shine")) c.remove();
  }
  // 转场要多久：GSAP 转场看时间线；共享元素看 reveal 的 auto-animate 时长（取页上写的最长的那个）
  function transitionSeconds(slide) {
    let t = current ? current.duration() : 0;
    if (slide.hasAttribute("data-auto-animate") && !slide.dataset.st) {
      const own = [slide, ...slide.querySelectorAll("[data-auto-animate-duration]")]
        .map((el) => +el.dataset.autoAnimateDuration || 0);
      t = Math.max(t, 0.9, ...own);
    }
    return t;
  }
  function startScene(slide, delay, prebuilt) {
    scene = prebuilt ?? sceneFor(slide);
    if (!scene) return;
    scene.pause(0);
    if (!CAPTURE) sceneCall = gsap.delayedCall(delay, () => (scene?.data?.stops ? playStep(0) : scene?.play(0)));
  }

  // ───────── 页内动画的点击分步 ─────────
  // 有页内动画的页，场景时间线上记着每一步停在哪（data.stops）。放映时一步一步放，翻页键先推下一步：
  //   这一步还在放 → 剩下的压到 FINISH_S 秒放完，停住（PowerPoint 里放动画时点一下也是先放完这一个）；
  //   这一步放完了、后面还有 → 放下一步；
  //   全放完了 → 翻页。
  let stepAt = -1;      // 放到第几步了（-1 = 还在等转场放完）
  let stepTween = null; // 推着场景时间线走完这一步的那个补间
  function playStep(i) {
    const stops = scene.data.stops;
    sceneCall?.kill();
    sceneCall = null;
    stepTween?.kill();
    stepAt = i;
    stepTween = scene.tweenFromTo(i ? stops[i - 1] : 0, stops[i], { ease: "none" });
    reportStep();
  }
  // 这一页按到第几下了（done），一共要按几下（clicks）。第 0 步是进页自己放的，不算一下
  function stepState() {
    const stops = scene?.data?.stops;
    return stops ? { done: Math.max(0, stepAt), clicks: stops.length - 1 } : { done: 0, clicks: 0 };
  }
  // 宿主（Orca PPT 底栏的「第 1/3 下」）听这个事件，不用轮询
  const reportStep = () => document.dispatchEvent(new CustomEvent("orca:step", { detail: stepState() }));
  function stepNext() {
    const stops = scene?.data?.stops;
    if (!stops) return false;
    if (stepAt < 0) {
      playStep(0);
      return true;
    }
    if (stepTween?.isActive()) {
      const left = (stepTween.duration() - stepTween.time()) / stepTween.timeScale();
      if (left > FINISH_S) stepTween.timeScale(stepTween.timeScale() * (left / FINISH_S));
      return true;
    }
    if (stepAt < stops.length - 1) {
      playStep(stepAt + 1);
      return true;
    }
    return false;
  }
  // 页内动画还要多久放完这一步（秒）。自动播放用它决定什么时候按下一下，不用把页内动画的时长抄进 data-hold
  window.__orcaBusy = () => {
    const stops = scene?.data?.stops;
    if (!stops) return 0;
    if (stepAt < 0) return (sceneCall ? sceneCall.duration() - sceneCall.time() : 0) + stops[0];
    return stepTween?.isActive() ? (stepTween.duration() - stepTween.time()) / stepTween.timeScale() : 0;
  };
  window.__orcaStep = stepState;
  // 把这一页的页内动画从头再放一遍（Orca PPT 的「重放这页的动画」）。点击分步的页回到第 0 步，等人再按
  window.__orcaReplayBuild = () => {
    const slide = Reveal.getCurrentSlide();
    if (!slide) return;
    stopScene();
    startScene(slide, 0);
    reportStep();
  };
  // 这一页的页内动画清单（只读）。Orca PPT 的右栏「页」那一档显示它，宿主不用自己再解析一遍 data-anim。
  // 时长按放映算（步与步之间不空 STEP_GAP）；clicks 是要按几下翻页键才放完。没有页内动画时返回 null
  window.__orcaBuilds = (index) => {
    const slide = index === undefined ? Reveal.getCurrentSlide() : Reveal.getSlide(index);
    const found = slide && collectBuilds(slide);
    if (!found) return null;
    // 名字优先（data-id、领头元素的键），其次是字，都没有才写标签
    const label = (el) => {
      const name = el.dataset.id || el.dataset.lead;
      if (name) return name;
      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (text) return text.length > 16 ? `${text.slice(0, 16)}…` : text;
      const cls = [...el.classList].find((c) => /^[st]-/.test(c));
      return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}>`;
    };
    const items = [];
    for (const m of found.movers) {
      const end = m.keys[m.keys.length - 1][0];
      const effects = [{ kind: "path", dir: null, at: m.keys[0][0], dur: end - m.keys[0][0] }];
      const l = found.lights.find((q) => q.m === m);
      if (l) effects.push({ kind: "light", dir: null, at: l.on, dur: Math.max(0, end - l.on), key: l.key });
      items.push({ label: label(m.el), step: m.step, effects });
    }
    for (const el of found.lit) items.push({ label: label(el), step: stepOf(el), effects: [{ kind: "lit", dir: null, at: 0, dur: 0, key: el.dataset.lit }] });
    for (const x of found.anims) items.push({ label: label(x.el), step: x.step, effects: x.list.map((a) => ({ kind: a.kind, dir: a.dir, at: a.at, dur: a.dur })) });
    const steps = found.steps.map((step) => ({ step, length: found.len.get(step) }));
    return { total: Math.round(steps.reduce((t, x) => t + x.length, 0) * 100) / 100, clicks: steps.length - 1, steps, items };
  };


  function cleanup() {
    // 先跑到终点再销毁，避免中途翻页时元素停在隐藏状态
    current?.progress(1).kill();
    current = null;
    for (const el of document.querySelectorAll(".st-ghost, .st-ghost-el, .st-mask")) el.remove();
    for (const el of document.querySelectorAll(".st-enter")) gsap.set(el, { clearProps: "all" });
    clearBlur();
  }

  function onSlide(e) {
    stopScene();
    stopRecap();
    // 先把新页的场景图形建出来（停在第 0 秒），转场才能拿场景里生成的元素当锚点
    const next = sceneFor(e.currentSlide);
    next?.pause(0);
    const played = runTransition(e);
    // 往回翻、跳页没有转场，场景和视频直接从头播
    const delay = played ? transitionSeconds(e.currentSlide) : 0;
    startScene(e.currentSlide, delay, next);
    reportStep();
    playVideos(e.currentSlide, delay);
    startRecap(e.currentSlide, delay);
  }

  function runTransition({ currentSlide, previousSlide, indexh }) {
    cleanup();
    const forward = lastIndex !== null && indexh === lastIndex + 1;
    lastIndex = indexh;
    if (!previousSlide || !forward) return false;
    const kind = currentSlide.dataset.st;
    if (!kind) {
      if (currentSlide.hasAttribute("data-auto-animate") && previousSlide.hasAttribute("data-auto-animate")) {
        current = autoAnimateExtras(currentSlide, previousSlide);
        current.progress(0);
        if (!CAPTURE) current.play();
        return true;
      }
      return false;
    }
    const build = builders[kind];
    if (!build) {
      console.error(`[orca-transition-skill] 不认识的 data-st="${kind}"，可选：${Object.keys(builders).join(" / ")}`);
      return false;
    }
    const enter = currentSlide.querySelector(":scope > .st-enter");
    const ghost = snapshot(previousSlide);
    currentSlide.prepend(ghost);
    // 减少动效:大幅缩放换成原地淡化 —— 上一页的快照盖在新页上,淡掉就露出新页
    current = CALM && CALM_REPLACE.has(kind)
      ? timeline().to(ghost, { autoAlpha: 0, duration: CALM_FADE_S, ease: "power1.inOut" }, 0)
      : build(currentSlide, ghost, enter);
    current.progress(0);
    if (!CAPTURE) current.play();
    return true;
  }

  // ───────── 往前翻：转场没放完时不许跳 ─────────
  // 转场放到一半按 →，reveal 立刻切页、发 slidechanged，而这个事件取消不了 —— 到那时只能由
  // cleanup 把正在跑的转场拨到终点，观众看到一次跳帧（实测一变多放到 14% 被拨走，跳过 1.8 秒）。
  // 录制是离线逐帧 seek，永远碰不到这种情况，自检也查不出来。所以在翻页**之前**拦：
  //   - 转场在跑：把剩下的部分压到 FINISH_S 秒放完，再翻；
  //   - 压着的这段时间里又按了：当成要跳过去，放完后直接跳到目标页（跳页本来就没有转场）。
  // 宿主（比如 Orca PPT 的画布、自动播放）要往前翻时调 window.__orcaAdvance()，别直接 Reveal.next()。
  // 人明说要去下一页（点了页胶片上的下一页）时调 window.__orcaAdvance({ page: true })：转场照样先放完，
  // 但不再一步一步推页内动画 —— 不然页内动画正在放时点下一页，只放完这一步、页不动，页胶片和画布就对不上了。
  const FINISH_S = 0.3;   // 0.15 秒收尾像一下跳到终点，2026-10-28 并排看过定 0.3
  let queued = 0;
  const cssTransitions = () =>
    document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === "running");
  function advance({ page = false } = {}) {
    if (CAPTURE) return Reveal.next();
    if (queued) {
      queued++;
      return;
    }
    // 共享元素走 reveal 的 auto-animate，是 CSS transition，不在 current 里，要一起看
    const running = cssTransitions();
    if (!current?.isActive() && running.length === 0) {
      if (!page && stepNext()) return "step";
      return Reveal.next();
    }
    // 转场在跑、这一页有页内动画：只把转场压完，接着放第 0 步，不翻页
    const stepped = !page && !!scene?.data?.stops;

    queued = 1;
    const done = [];
    if (current?.isActive()) {
      const tl = current;
      const left = (tl.duration() - tl.time()) / tl.timeScale();
      if (left > FINISH_S) tl.timeScale(tl.timeScale() * (left / FINISH_S));
      done.push(new Promise((resolve) => tl.eventCallback("onComplete", resolve)));
    }
    for (const a of running) {
      const left = (a.effect.getComputedTiming().endTime - a.currentTime) / a.playbackRate;
      if (left > FINISH_S * 1000) a.playbackRate *= left / (FINISH_S * 1000);
      done.push(a.finished.catch(() => {}));
    }
    // 等真正放完再翻 —— 按固定时长翻的话，掉帧时最后一截还是会被 cleanup 拨掉。
    // 兜底一个超时：页面在后台时 rAF 会停，别让翻页永远卡住。
    const timeout = new Promise((resolve) => setTimeout(resolve, FINISH_S * 1000 + 400));
    Promise.race([Promise.all(done), timeout]).then(() => {
      const steps = queued;
      queued = 0;
      if (stepped) {
        if (stepAt < 0) playStep(0);
      } else if (steps === 1) Reveal.next();
      else Reveal.slide(Math.min(Reveal.getIndices().h + steps, Reveal.getTotalSlides() - 1));
    });
  }
  window.__orcaAdvance = advance;

  // ───────── 宿主换掉一页，不重载整份稿子 ─────────
  // Orca PPT 里 agent 或人只改了某一页时调 window.__orcaReplaceSlide(index, html)，html 是那一页 <section> 的源码。
  // 换掉这一页的 DOM，只对它重做加载时的准备，再让 reveal 认新的这一页（Reveal.sync / syncSlide）。
  // 做不了就返回 false，宿主整份重载：页号不对、源码不是一个 section、有纵向页、页里有脚本（换进来不会执行）。
  window.__orcaReplaceSlide = (index, html) => {
    if (CAPTURE || EMBED) return false;
    const old = allSlides()[index];
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html).trim();
    const fresh = tpl.content.firstElementChild;
    if (!old || !fresh || tpl.content.childElementCount !== 1 || fresh.tagName !== "SECTION") return false;
    if (fresh.querySelector("section, script") || old.querySelector("section")) return false;
    const showing = old === Reveal.getCurrentSlide();
    // 转场放到一半就换：先拨到终点，收掉 ghost
    cleanup();
    if (showing) {
      stopScene();
      stopRecap();
    }
    for (const v of within([old], "video")) v.pause();
    old.replaceWith(fresh);
    const slides = [fresh];
    prepare(slides);
    prepareFills(slides);
    prepareLamps(slides);
    prepareStory(slides);
    prepareVideos(slides);
    prepareRecaps(slides);
    // 别的页上的回顾屏正好回顾到这一页：嵌着的那份重新载
    const reloaded = [];
    for (const frame of document.querySelectorAll(".reveal .slides .s-recap")) {
      const r = frame.__recap;
      if (!r || fresh.contains(frame) || index < r.range.from || index > r.range.to) continue;
      recapReady.delete(r.iframe.contentWindow);
      r.iframe.remove();
      delete frame.__recap;
      delete frame.__ctl;
      embedRecap(frame);
      reloaded.push(frame);
    }
    Reveal.sync();
    // reveal 记着的当前页还是旧的那个 DOM：原地再 slide 一次换成新的（页号没变，不发 slidechanged）
    if (showing) Reveal.slide(index);
    Reveal.syncSlide(fresh);
    const now = Reveal.getCurrentSlide();
    if (showing) {
      // 停在页内动画放完的样子：和缩略图一致，宿主框出改动处时元素也不会再动
      scene = sceneFor(fresh);
      if (scene) {
        scene.progress(1).pause();
        if (scene.data?.stops) stepAt = scene.data.stops.length - 1;
      }
      reportStep();
      playVideos(fresh, 0);
    }
    if (showing || reloaded.some((frame) => now.contains(frame))) startRecap(now, 0);
    return true;
  };

  prepare();
  prepareFills();
  prepareLamps();
  prepareStory();
  prepareVideos();
  prepareRecaps();
  // 单独打开（双击 deck.html、AI 助手的内置浏览器）时给一条播放条（见文末）：没有 Orca PPT 的画布和
  // 工具栏，页面上又没有任何能点的东西，不知道按键盘的人只能看到第一页。
  // 在 Orca PPT 里（画布、放映都经 http 加载）、录制和导出（?capture、自动化浏览器）、总览和回顾屏的
  // 小格子（?embed）里都不给。只看「不是 http(s)」，不认准 file:：AI 助手的内置浏览器未必直接开文件 ——
  // DeepSeek Harness 把引到的 CSS / JS 打包成 blob: 地址，套进沙箱 iframe 里放。
  const STANDALONE = !/^https?:$/.test(location.protocol) && !CAPTURE && !EMBED && !navigator.webdriver;
  // 页号写进网址（#/3）要能改 history。沙箱里的 blob: 页面（DeepSeek Harness 的内置浏览器）一改就抛错，
  // reveal 的 ready、换页事件跟着断掉 —— 改不了就不写，翻页照常
  const HASH = (() => {
    try {
      // 照 reveal 的写法试（路径 + 查询，再带上原来的 #，网址不变）：不带网址、带完整网址的调用沙箱里都放行
      history.replaceState(history.state, "", location.pathname + location.search + location.hash);
      return true;
    } catch {
      return false;
    }
  })();
  Reveal.initialize({
    width: W,
    height: H,
    margin: 0,
    center: false,
    controls: false,
    // 单独打开时换成自己的总览（见文末 openOverview）：reveal 的总览不按窗口排，当前页摆正中，
    // AI 助手那种窄高的面板里只剩下半截的一条
    overview: !STANDALONE,
    // reveal 在窄于 435px 的窗口里自动改成竖着滚的「滚动视图」：AI 助手的窄面板、总览里的小格子
    // 都会被它变成一长条。稿子永远按页放
    scrollActivationWidth: null,
    // reveal 默认最小缩到 0.2：总览的格子 300px 宽只要 0.16，按 0.2 放就裁掉了左右两边
    minScale: 0.05,
    progress: false,
    hash: HASH,
    transition: "none",
    backgroundTransition: "none",
    autoAnimateDuration: 0.9,
    autoAnimateEasing: "cubic-bezier(0.65, 0, 0.35, 1)",
    // reveal 默认那一组，加上 rotate。auto-animate 自己用 transform 做位移和缩放，元素的旋转写在
    // transform 里会被盖掉，所以「绕圆心转」写 CSS 的独立属性 rotate（transitions.md「绕圆心转」）
    autoAnimateStyles: ["opacity", "color", "background-color", "padding", "font-size", "line-height",
      "letter-spacing", "border-width", "border-color", "border-radius", "outline", "outline-offset", "rotate"],
    // 往前翻的键都交给 advance（见上）。往回翻不管：往回本来就是硬切。
    // ↓ / ↑ 也翻页：稿子没有纵向的页，reveal 默认的上下导航在这里什么都不做，
    // 而 Orca PPT 的页胶片是竖着排的，人会顺手按上下。
    keyboard: EMBED
      ? false
      : { 32: advance, 34: advance, 39: advance, 40: advance, 76: advance, 78: advance, 38: () => Reveal.prev(),
          ...(STANDALONE ? { 27: () => openOverview(), 79: () => openOverview() } : {}) },
  });
  Reveal.on("ready", (e) => {
    lastIndex = e.indexh;
    startScene(e.currentSlide, 0);
    playVideos(e.currentSlide, 0);
    startRecap(e.currentSlide, 0);
    if (EMBED) serveRecap();
  });
  Reveal.on("slidechanged", onSlide);

  // 往回翻、跳页一律硬切。转场都是按往后翻一页设计的，但 reveal 的 auto-animate 不看方向：
  // 往回时只要离开的那页没有 restart 就会倒着动（只有形态变换，没有错开入场这些补充），
  // 结果一半页面倒着动一半硬切。切页前给两页临时补上 restart，切完拿掉。
  const tempRestart = [];
  Reveal.on("beforeslidechange", (e) => {
    const from = Reveal.getIndices().h;
    if (e.indexh === undefined || e.indexh === from || e.indexh === from + 1) return;
    for (const s of [Reveal.getSlide(from), Reveal.getSlide(e.indexh)]) {
      if (!s || s.hasAttribute("data-auto-animate-restart")) continue;
      s.setAttribute("data-auto-animate-restart", "");
      tempRestart.push(s);
    }
  });
  Reveal.on("slidechanged", () => {
    for (const s of tempRestart.splice(0)) s.removeAttribute("data-auto-animate-restart");
  });

  // 本次转场的 CSS 动画。暂停的动画不会自己结束，不单独记下来的话，
  // 下一次 seek 会把上一次转场的动画也倒回去，ghost 克隆时就拍到错误的状态。
  let captured = [];
  let sceneOffset = 0;    // 场景和视频在这一段录制里从第几毫秒开始（= 转场结束）
  let videos = [];        // 这一页上的视频，逐帧 seek 用

  window.__capture = {
    // 切页后等两帧，让 auto-animate 把 CSS transition 挂上，再全部冻住。返回这次转场的总时长（毫秒）
    async go(index) {
      for (const a of captured) a.finish();
      current?.progress(1);
      const target = Reveal.getSlide(index);
      if (Reveal.getIndices().h === index && !scene) startScene(target, 0); // 第一页不会触发 slidechanged
      Reveal.slide(index);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      captured = document.getAnimations();
      let end = 0;
      for (const a of captured) {
        a.pause();
        end = Math.max(end, a.effect.getComputedTiming().endTime);
      }
      if (current) end = Math.max(end, current.duration() * 1000);
      let hold = +(target.dataset.hold || 1.5) * 1000;
      // 有场景动画时：停留至少要放完场景，再多停 0.8 秒看清结尾
      const sceneMs = scene ? scene.duration() * 1000 : 0;
      if (sceneMs) hold = Math.max(hold, sceneMs + 800);
      // 有视频时：停留至少要放完视频。data-hold 写得更长就按 data-hold（片尾定格）
      videos = videosOf(target);
      let videoMs = 0;
      for (const v of videos) {
        v.pause();
        if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
        videoMs = Math.max(videoMs, v.duration * 1000);
      }
      if (videoMs) hold = Math.max(hold, videoMs);
      // 淡出的视频克隆体：等它解出停住的那一帧再开始录，否则前几帧是空的
      for (const v of target.querySelectorAll(".st-ghost video, .st-ghost-el video, video.st-ghost-el")) {
        if (v.readyState < 2) await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); v.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 2000); });
      }
      // 有回顾屏时：停留至少要放完回顾，再定格 1.5 秒看清名单
      let recapMs = 0;
      if (recap) {
        await recap.ready;
        recapMs = recap.total;
        hold = Math.max(hold, recapMs + 1500);
      }
      sceneOffset = end;
      // build：页内动画（含点击分步）放完要多久。缩略图停在这之后 —— 那才是这一页「完整」的样子
      const buildMs = scene?.data?.stops ? sceneMs : 0;
      return { transition: end, hold, scene: sceneMs || recapMs, video: videoMs, build: buildMs };
    },
    async seek(ms) {
      for (const a of captured) a.currentTime = Math.min(ms, a.effect.getComputedTiming().endTime);
      current?.time(ms / 1000);
      scene?.time(Math.max(0, ms - sceneOffset) / 1000);
      await Promise.all(videos.map((v) => seekVideo(v, Math.max(0, ms - sceneOffset) / 1000)));
      await recap?.time(Math.max(0, ms - sceneOffset));
    },
    count: () => Reveal.getTotalSlides(),
    // 放映时转场没放完就按下一页,剩下的在这么多毫秒里快进放完(见 advance)。
    // capture.mjs 的 --interrupt 按它录「中途打断」那一段,两边必须是同一个数。
    finishMs: FINISH_S * 1000,
  };

  // ── 单独打开时的总览 ───────────────────────────────────────────────
  // 每页一格，按窗口宽度排成网格，一屏放不下就竖着滚：横的窗口一行几页，AI 助手窄高的面板里一两列。
  // 每格是这一页的克隆，放在 shadow DOM 里：引擎查页面（document.querySelectorAll）查不进去，
  // 不会把克隆当成真的页面；把稿子的样式表也抄进去、外面套一层 .reveal .slides，版式规则照样生效。
  // 不用「每格一个 iframe 再载入一次这个文件」：AI 助手的内置浏览器未必能再载入一次（DeepSeek 的 blob:）。
  // 进出：Esc / O，或右下角箭头旁的按钮；点一格跳到那一页。
  let overview = null;
  function openOverview() {
    if (overview) return closeOverview();
    const here = Reveal.getIndices().h;
    overview = document.createElement("div");
    overview.className = "st-overview";
    overview.setAttribute("role", "dialog");
    overview.setAttribute("aria-label", "总览");
    const sheets = [...document.querySelectorAll('link[rel="stylesheet"], style')];
    for (let i = 0; i < Reveal.getTotalSlides(); i++) {
      // 不用 <button>：按钮里不能放 iframe，Chrome 会把里面的页面画坏
      const cell = document.createElement("div");
      cell.className = "st-overview-cell";
      cell.setAttribute("role", "button");
      cell.tabIndex = 0;
      if (i === here) cell.setAttribute("aria-current", "page");
      cell.setAttribute("aria-label", `第 ${i + 1} 页`);
      const label = document.createElement("span");
      label.textContent = i + 1;
      cell.append(thumbnail(Reveal.getSlide(i), sheets), label);
      const pick = () => { closeOverview(); Reveal.slide(i); };
      cell.addEventListener("click", pick);
      cell.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      overview.append(cell);
    }
    document.body.append(overview);
    fitOverview();
    window.addEventListener("resize", fitOverview);
    overview.querySelector("[aria-current]")?.scrollIntoView({ block: "center" });
    overview.querySelector("[aria-current]")?.focus({ preventScroll: true });
    // 开着时键盘归总览：Esc / O 关掉，别的键不翻底下的页
    window.addEventListener("keydown", overviewKeys, true);
  }
  // 列数按窗口宽度算：每格至少 280px 宽。不交给 CSS 的 auto-fill —— 那样行高按最小列宽算，
  // 格子实际更宽、更高，一列时会叠在一起
  function fitOverview() {
    if (!overview) return;
    const columns = Math.max(1, Math.floor((overview.clientWidth - 16) / (280 + 16)));
    overview.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  }
  function thumbnail(slide, sheets) {
    const host = document.createElement("div");
    host.className = "st-overview-thumb";
    const root = host.attachShadow({ mode: "open" });
    for (const sheet of sheets) root.append(sheet.cloneNode(true));
    const stage = document.createElement("div");
    stage.className = "reveal";
    stage.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0;overflow:hidden;background:var(--bg)`;
    const slides = document.createElement("div");
    slides.className = "slides";
    slides.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;margin:0;transform:none`;
    const page = slide.cloneNode(true);
    page.classList.remove("past", "future");
    page.classList.add("present");
    page.removeAttribute("hidden");
    page.removeAttribute("aria-hidden");
    page.style.display = "block";
    // 克隆的视频别自己放、别抢声音
    for (const video of page.querySelectorAll("video")) {
      video.removeAttribute("autoplay");
      video.muted = true;
      video.preload = "metadata";
    }
    slides.append(page);
    stage.append(slides);
    root.append(stage);
    new ResizeObserver(() => { stage.style.transform = `scale(${host.clientWidth / W})`; }).observe(host);
    return host;
  }
  function closeOverview() {
    window.removeEventListener("resize", fitOverview);
    overview?.remove();
    overview = null;
    window.removeEventListener("keydown", overviewKeys, true);
  }
  function overviewKeys(e) {
    if (e.key === "Escape" || e.key === "o" || e.key === "O") {
      e.preventDefault();
      closeOverview();
    }
    if (e.key === "Enter" || e.key === " " || e.key === "Tab") return; // 按钮自己的点击和焦点移动
    e.stopPropagation();
  }
  // 单独打开时底部居中的播放条：上一页、页码、总览、下一页。鼠标停 2 秒淡出，一动就出来；
  // 触屏没有悬停，一直显示（见 tokens.css）。下一页走 advance：页内有分步动画时先放完这一步
  if (STANDALONE) {
    const ICONS = {
      prev: '<path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
      next: '<path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
      grid: '<path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    };
    const bar = document.createElement("div");
    bar.className = "st-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "放映");
    const button = (icon, label, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.title = label;
      b.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[icon]}</svg>`;
      b.addEventListener("click", onClick);
      return b;
    };
    const prev = button("prev", "上一页（←）", () => Reveal.prev());
    const next = button("next", "下一页（→）", () => advance());
    const page = document.createElement("span");
    page.className = "st-bar-page";
    bar.append(prev, page, button("grid", "总览（Esc）", () => openOverview()), next);
    document.body.append(bar);

    const update = () => {
      const at = Reveal.getIndices().h;
      const total = Reveal.getTotalSlides();
      page.textContent = `${at + 1} / ${total}`;
      // 下一页不置灰：最后一页也可能还有没放完的分步动画
      prev.disabled = at === 0;
    };
    Reveal.on("ready", update);
    Reveal.on("slidechanged", update);
    if (Reveal.isReady()) update();

    let idle;
    const wake = () => {
      bar.classList.remove("st-bar-idle");
      clearTimeout(idle);
      idle = setTimeout(() => { if (!bar.matches(":hover, :focus-within")) bar.classList.add("st-bar-idle"); }, 2000);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    wake();
  }
})();
