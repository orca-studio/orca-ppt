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

  // data-st 页：把原内容包进 .st-enter，方便整体移动
  function prepare() {
    // data-st 页自动补上 data-auto-animate + restart：reveal 不会从上一页自动动画进来（由 GSAP 接管），
    // 但下一页仍然可以从这一页做共享元素。
    for (const section of document.querySelectorAll(".reveal .slides > section[data-st]")) {
      section.setAttribute("data-auto-animate", "");
      section.setAttribute("data-auto-animate-restart", "");
    }
    for (const section of document.querySelectorAll(".reveal .slides > section[data-auto-animate]")) {
      section.setAttribute("data-auto-animate-unmatched", "false");
    }
    // 绕圆心转：rotate 绕 transform-origin 转，而 auto-animate 不管位置变没变都把它设成
    // top left !important，扇形就绕盒子左上角甩出去（录制时这条样式一直留着，扇形停在画面外）。
    // 标上 data-st-turn，由 tokens.css 里更具体的 !important 规则压回来：默认绕盒子中心，
    // 作者自己写了 transform-origin（比如指针绕底端）就用作者的
    // 只标真的转了的：整份稿子里这个元素（按 data-id 认）至少有一页角度不是 0。
    // 全程 0° 的元素照 reveal 默认绕左上角变形 —— 改成绕中心后，又平移又缩放的元素中途会冲出原来的范围
    const turned = new Set();
    for (const el of document.querySelectorAll(".reveal .slides > section [style*='rotate']")) {
      if (el.dataset.id && parseFloat(el.style.rotate)) turned.add(el.dataset.id);
    }
    for (const el of document.querySelectorAll(".reveal .slides > section [style*='rotate']")) {
      if (!el.style.rotate) continue;
      if (!parseFloat(el.style.rotate) && !turned.has(el.dataset.id)) continue;
      el.dataset.stTurn = "";
      el.style.setProperty("--st-origin", el.style.transformOrigin || "50% 50%");
    }
    for (const section of document.querySelectorAll(".reveal .slides > section[data-st]")) {
      const enter = layer("st-enter");
      enter.append(...section.childNodes);
      section.append(enter);
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
    gsap.set(el, spec.from);
    tl.to(el, to, at);
  }
  const AUTHORED_OPACITY = new WeakMap();


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
    const pairedOld = new Set(pairs.map((p) => p.old));
    const pairedNew = new Set(pairs.map((p) => p.next));
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
    // 替换对的旧元素压在新元素正下方，交叉溶解时层次才对
    for (const p of pairs) {
      const g = ghostOf.get(p.old);
      if (g) p.next.before(g);
    }
    const tl = timeline();
    // 从元素自己的透明度淡出：本来就透明（opacity:0 待命）的元素不能先被设成不透明再淡出，那会闪一下
    tl.fromTo(ghosts, { autoAlpha: (_, el) => +getComputedStyle(el).opacity, y: 0 }, { autoAlpha: 0, y: -16, duration: 0.35, ease: "power1.in" }, 0);
    // 写了页内动画的元素（或里面包着它们的组）入场归页内动画管：这里再让它上浮淡入，
    // 转场一结束它就已经看得见了，点击分步的「点一下才出来」就没了
    const BUILD = "[data-anim], [data-path], [data-lit], [data-step]";
    const incoming = [...section.children].filter((el) =>
      !prevIds.has(el.dataset.id) && !el.matches(".st-layer, .st-ghost-el") && !pairedNew.has(el)
      && !(!el.dataset.id && prevSame.has(signature(el)))
      && !el.matches(BUILD) && !el.querySelector(BUILD));
    for (const el of incoming) enterTween(tl, el, +(el.dataset.autoAnimateDelay ?? 0.6));
    for (const p of pairs) {
      const g = ghostOf.get(p.old);
      if (!g) continue;
      const d = +p.next.dataset.duration
        || (p.attr === "swap" ? SWAP_D : p.next.hasAttribute("data-roll") ? ROLL_D : TEXT_D);
      (p.attr === "swap" ? swapTween : textTween)(tl, g, p.next, d);
    }
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
      tl.to(el, { ...end, borderRadius: `${end.borderRadius}px`, duration: move, ease: "power3.inOut" }, i * stagger);
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
      tl.to(el, { ...to, borderRadius: `${to.borderRadius}px`, duration: move, ease: "power3.inOut" }, i * stagger);
    });
    tl.set(target, { autoAlpha: 1 }, landed);
    tl.set(srcs, { autoAlpha: 0 }, landed);
    const restAt = landed * 0.8;
    newRest.forEach((el, i) => enterTween(tl, el, +(el.dataset.enterDelay ?? restAt + i * 0.04)));
    tl.set(sameNew, { autoAlpha: 1 }, Math.max(d, landed));
    tl.set(sameOld, { autoAlpha: 0 }, Math.max(d, landed));
    return tl;
  };

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

  function prepareStory() {
    for (const section of document.querySelectorAll(".reveal .slides > section")) {
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
  function prepareRecaps() {
    for (const frame of document.querySelectorAll(".reveal .slides .s-recap")) {
      gsap.set(frame, recapTransform(frame));
      if (EMBED) continue;
      const range = recapRange(frame);
      if (!range) {
        console.error(`[orca-transition-skill] .s-recap 需要 data-recap="起页-止页"（页号从 1 数），比如 data-recap="2-6"`);
        continue;
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
    // 名单：把条目包进一层，滚动只动这一层，外框负责裁切和上下渐隐
    for (const list of document.querySelectorAll(".reveal .slides .t-credits")) {
      const roll = document.createElement("div");
      roll.className = "st-roll";
      roll.append(...list.childNodes);
      list.append(roll);
    }
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
    const builds = buildsFor(slide);
    if (!motion || !builds) return motion || builds;
    const tl = gsap.timeline({ paused: true }).add(motion, 0).add(builds, 0);
    // 场景动画算在第 0 步里：第 0 步至少要等场景放完
    const stops = builds.data.stops.slice();
    stops[0] = Math.max(stops[0], motion.duration());
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
  //   data-lit="键"                    只在同键光束照到的地方可见（clip-path 跟着光束每帧重算）。
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
  //   方向是「从哪边来」：fly right 从右边飞进来，wipe left 从左往右擦出来。
  // 点击分步（data-step="n"）：写了的元素（或它所在的组）等第 n 次按翻页键才动，没写的是第 0 步，进页自己动。
  //   放映时每一步放完停住，按键放下一步；全部放完再按才翻页。录制没人按键，步与步之间空 STEP_GAP 秒连着放。
  const STEP_GAP = 0.6;
  const ANIM_DUR = { fade: 0.5, rise: 0.6, zoom: 0.5, fly: 0.6, wipe: 0.7, trail: 0.6, shine: 0.9, out: 0.4 };
  const ANIM_DIR = { fly: "down", wipe: "left", trail: "right" };
  const TRAIL = [0.45, 0.28, 0.14]; // 拖影：每份副本的不透明度，越往后越淡
  const TRAIL_LAG = 0.05;           // 拖影：副本之间错开的秒数
  const SHINE_BAND = 260;           // 擦亮：光带宽（px，和 tokens.css .st-shine 的 background-size 一致）
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
    }));
    const lit = own("[data-lit]");
    const anims = own("[data-anim]").map((el) => ({ el, step: stepOf(el), list: parseAnims(el) })).filter((x) => x.list.length);
    if (!movers.length && !lit.length && !anims.length) return null;

    // 每一步多长。第 0 步总是有（可以是 0 秒），这样「进页先停住，点一下才出来」也成立
    const len = new Map([[0, 0]]);
    const bump = (s, t) => len.set(s, Math.max(len.get(s) ?? 0, t));
    for (const m of movers) bump(m.step, m.keys[m.keys.length - 1][0]);
    for (const l of lights) bump(l.m.step, l.on);
    for (const x of anims) for (const a of x.list) bump(x.step, a.at + a.len);
    const steps = [...len.keys()].sort((p, q) => p - q);
    return { movers, lights, lit, anims, len, steps };
  }
  function buildsFor(slide) {
    if (!slide) return null;
    for (const c of slide.querySelectorAll(".st-trail, .st-shine")) c.remove();
    const found = collectBuilds(slide);
    if (!found) return null;
    const { movers, lights, lit, anims, len, steps } = found;
    for (const m of movers) {
      const el = m.el;
      const [px, py] = el.dataset.pivot ? el.dataset.pivot.trim().split(/[\s,]+/).map(Number) : [];
      const pivot = [Number.isFinite(px) ? px : el.offsetWidth / 2, Number.isFinite(py) ? py : el.offsetHeight / 2];
      el.style.transformOrigin = `${pivot[0]}px ${pivot[1]}px`;
      m.rest = [el.offsetLeft + pivot[0], el.offsetTop + pivot[1]];
      m.pose = null;
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
        m.el.style.transform = `translate(${x - m.rest[0]}px, ${y - m.rest[1]}px) rotate(${a}deg)`;
      }
      for (const el of lit) {
        const l = lights.find((q) => q.key === el.dataset.lit);
        if (!l || t - start.get(l.m.step) < l.on) { el.style.clipPath = "polygon(0 0, 0 0, 0 0)"; continue; }
        const [x, y, a] = l.m.pose;
        const r = (a * Math.PI) / 180, dx = Math.sin(r), dy = -Math.cos(r), nx = Math.cos(r), ny = Math.sin(r);
        const far = l.w + LIGHT_L * l.spread;
        const ox = el.offsetLeft, oy = el.offsetTop;
        const pt = (along, side) => `${(x + dx * along + nx * side - ox).toFixed(1)}px ${(y + dy * along + ny * side - oy).toFixed(1)}px`;
        el.style.clipPath = `polygon(${pt(0, -l.w)}, ${pt(0, l.w)}, ${pt(LIGHT_L, far)}, ${pt(LIGHT_L, -far)})`;
      }
    };
    const tl = gsap.timeline({ paused: true });
    if (movers.length || lit.length) {
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
  function prepareVideos() {
    for (const v of document.querySelectorAll(".reveal .slides video")) {
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
  // 宿主（OrcaPPT 底栏的「第 1/3 下」）听这个事件，不用轮询
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
  // 把这一页的页内动画从头再放一遍（OrcaPPT 的「重放这页的动画」）。点击分步的页回到第 0 步，等人再按
  window.__orcaReplayBuild = () => {
    const slide = Reveal.getCurrentSlide();
    if (!slide) return;
    stopScene();
    startScene(slide, 0);
    reportStep();
  };
  // 这一页的页内动画清单（只读）。OrcaPPT 的右栏「页」那一档显示它，宿主不用自己再解析一遍 data-anim。
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
  // 宿主（比如 OrcaPPT 的画布、自动播放）要往前翻时调 window.__orcaAdvance()，别直接 Reveal.next()。
  const FINISH_S = 0.15;
  let queued = 0;
  const cssTransitions = () =>
    document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === "running");
  function advance() {
    if (CAPTURE) return Reveal.next();
    if (queued) {
      queued++;
      return;
    }
    // 共享元素走 reveal 的 auto-animate，是 CSS transition，不在 current 里，要一起看
    const running = cssTransitions();
    if (!current?.isActive() && running.length === 0) {
      if (stepNext()) return "step";
      return Reveal.next();
    }
    // 转场在跑、这一页有页内动画：只把转场压完，接着放第 0 步，不翻页
    const stepped = !!scene?.data?.stops;

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

  prepare();
  prepareStory();
  prepareVideos();
  prepareRecaps();
  Reveal.initialize({
    width: W,
    height: H,
    margin: 0,
    center: false,
    controls: false,
    progress: false,
    hash: true,
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
    // 而 OrcaPPT 的页胶片是竖着排的，人会顺手按上下。
    keyboard: EMBED
      ? false
      : { 32: advance, 34: advance, 39: advance, 40: advance, 76: advance, 78: advance, 38: () => Reveal.prev() },
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
})();
