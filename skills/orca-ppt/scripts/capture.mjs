// 把一份演示稿逐帧过一遍：每帧 seek 到确定时刻再截图，不依赖真实时间。
// 用法：node scripts/capture.mjs <deck.html> [--frames 目录] [-o out.mp4] [--fps 30] [--json report.json] [--interrupt 页号@毫秒]
// 每页的停留时长读 <section data-hold="秒">，默认 1.5。
//
// 默认不出视频，出的是自检要的东西：
// - 关键帧：每页转场里均匀取 5 帧（p03-t1.png … p03-t5.png），加停稳后的一帧（p03-end.png）。
//   写到 --frames 给的目录；不给就是系统临时目录下按稿子分的一个目录，路径会打印出来。
//   不往稿子目录里写：OrcaPPT 应用在监听那个目录，写进去画布就重载。
// - 转场动没动：每次转场里有几帧和上一帧不一样。seek 是确定的，没动的帧逐字节相同。
//   动的帧不到一半就打一条提醒 —— 多半是转场没真的动，跳过去了。
// -o out.mp4 才拼视频，要系统里有 ffmpeg。
//
// --interrupt 3@480：录第 3 页的转场时，在第 480 毫秒「按下一页」—— 按放映时的样子录：
// 剩下的转场在 __capture.finishMs 里快进放完，不停留，直接接下一页的转场。
// 放映时手快就是这样；逐帧录制平时碰不到，自检第 2 条（不许跳变）要靠它才验得到。可以写多个，用逗号隔开。
//
// --json 写一份机器可读的录制报告：页面自报的问题、每页的转场帧区间、时长。
// 给工具用的（比如 orca-ppt 的自检闸），人看 stdout 就行。
// 两份内容一致，但 stdout 的措辞随时可能改，别去解析它。
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("-") && !["-o", "--frames", "--fps", "--json", "--interrupt"].includes(args[i - 1]));
const deck = positional[0];
if (!deck) {
  console.error("用法：node scripts/capture.mjs <deck.html> [--frames 目录] [-o out.mp4] [--fps 30]");
  process.exit(1);
}
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const FPS = +opt("--fps", 30);
const out = args.includes("-o") ? path.resolve(opt("-o")) : null;
// 同一份稿子每次落在同一个目录，换一份稿子换一个
const deckKey = createHash("sha1").update(path.resolve(deck)).digest("hex").slice(0, 8);
const keyDir = path.resolve(
  opt("--frames", path.join(tmpdir(), "orca-ppt-capture", `${path.basename(path.dirname(path.resolve(deck)))}-${deckKey}`)),
);
const jsonOut = args.includes("--json") ? path.resolve(opt("--json")) : null;
// 页号(从 1 数,和输出里的「第 N 页」一致) → 在转场第几毫秒按下一页
const interrupts = new Map(
  String(opt("--interrupt", ""))
    .split(",")
    .filter(Boolean)
    .map((spec) => {
      const m = /^(\d+)@(\d+)$/.exec(spec.trim());
      if (!m) {
        console.error(`--interrupt 写成「页号@毫秒」，比如 3@480：${spec}`);
        process.exit(1);
      }
      return [+m[1] - 1, +m[2]];
    }),
);

const framesDir = mkdtempSync(path.join(tmpdir(), "orca-transition-capture-"));
// 每页一条，给 --json 用
const slides = [];
let n = 0;
const frameFile = (i) => path.join(framesDir, String(i).padStart(5, "0") + ".png");
const framePath = () => frameFile(n++);

// seek 后直接截图：截图本身会触发样式计算和绘制。实测在 seek 后多等两帧，录出的每一帧逐位不变
const seek = (ms) => page.evaluate((t) => window.__capture.seek(t), ms);

let browser;
let page;
const problems = [];
// 转场可能没动起来的提醒，不算页面报错
const notes = [];
try {
  // 用系统里装好的 Chrome，不下载浏览器
  browser = await chromium.launch({ channel: "chrome" });
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && problems.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));

  await page.goto(pathToFileURL(path.resolve(deck)).href + "?capture#/0");
  // 演示稿等 Reveal 就绪；orca-motion-skill 的单独预览页没有 Reveal，只等 __capture
  await page.waitForFunction(() => window.__capture && (!window.Reveal || window.Reveal.isReady?.()));
  await page.evaluate(() => document.fonts.ready);

  const total = await page.evaluate(() => window.__capture.count());
  for (let i = 0; i < total; i++) {
    const { transition, hold, scene, video } = await page.evaluate((idx) => window.__capture.go(idx), i);
    const at = interrupts.get(i);
    if (at !== undefined && at < transition && i < total - 1) {
      // 中途打断：录到 at，剩下的压进 finishMs 快进放完，不停留，下一轮直接录下一页的转场
      const finishMs = await page.evaluate(() => window.__capture.finishMs ?? 150);
      const left = transition - at;
      const ff = Math.min(left, finishMs);
      const firstFrame = n;
      const before = Math.round((at / 1000) * FPS);
      for (let f = 0; f < before; f++) {
        await seek((f / FPS) * 1000);
        await page.screenshot({ path: framePath() });
      }
      const ffFrames = Math.max(1, Math.round((ff / 1000) * FPS));
      for (let f = 1; f <= ffFrames; f++) {
        await seek(at + (left * f) / ffFrames);
        await page.screenshot({ path: framePath() });
      }
      slides.push({
        index: i,
        transitionMs: transition,
        holdMs: 0,
        transitionFrames: { from: firstFrame, to: n - 1 },
        interrupted: { atMs: at, fastForwardMs: ff, fastForwardFrames: { from: firstFrame + before, to: n - 1 } },
        sceneMs: 0,
        videoMs: 0,
        endFrame: n - 1,
      });
      console.log(`第 ${i + 1} 页：转场 ${(transition / 1000).toFixed(2)}s，在 ${at}ms 按了下一页，剩下的快进 ${ff}ms，转场帧 ${firstFrame}–${n - 1}`);
      continue;
    }
    const frames = Math.round((transition / 1000) * FPS);
    const firstFrame = n;
    for (let f = 0; f < frames; f++) {
      await seek((f / FPS) * 1000);
      await page.screenshot({ path: framePath() });
    }
    const holdFrames = Math.max(1, Math.round((hold / 1000) * FPS));
    if (scene || video) {
      // 页面里有场景动画（orca-motion-skill）或视频：停留期间也逐帧 seek
      for (let h = 0; h < holdFrames; h++) {
        await seek(transition + (h / FPS) * 1000);
        await page.screenshot({ path: framePath() });
      }
    } else {
      await seek(transition);
      const still = framePath();
      await page.screenshot({ path: still });
      for (let h = 1; h < holdFrames; h++) copyFileSync(still, framePath());
    }
    slides.push({
      index: i,
      transitionMs: transition,
      holdMs: hold,
      // 这一页的转场占了哪几帧（闭区间）。没有转场时为 null —— 匹配剪辑就是这种，
      // 它是硬切，本来就没有转场帧，别拿帧差量去验它。
      transitionFrames: frames ? { from: firstFrame, to: firstFrame + frames - 1 } : null,
      sceneMs: scene || 0,
      videoMs: video || 0,
      endFrame: n - 1,
    });
    const range = frames ? `，转场帧 ${firstFrame}–${firstFrame + frames - 1}` : "";
    const sceneNote = scene ? `，场景动画 ${(scene / 1000).toFixed(2)}s` : "";
    const videoNote = video ? `，视频 ${(video / 1000).toFixed(2)}s` : "";
    console.log(`第 ${i + 1} 页：转场 ${(transition / 1000).toFixed(2)}s，停留 ${(hold / 1000).toFixed(1)}s${range}${sceneNote}${videoNote}`);
  }
  await browser.close();
  browser = null;

  rmSync(keyDir, { recursive: true, force: true });
  mkdirSync(keyDir, { recursive: true });
  for (const slide of slides) {
    const page = String(slide.index + 1).padStart(2, "0");
    const keyframes = [];
    const t = slide.transitionFrames;
    if (t) {
      const span = t.to - t.from;
      const picks = [...new Set([0, 1, 2, 3, 4].map((k) => t.from + Math.round((span * k) / 4)))];
      picks.forEach((f, k) => {
        const file = path.join(keyDir, `p${page}-t${k + 1}.png`);
        copyFileSync(frameFile(f), file);
        keyframes.push(file);
      });
      let changed = 0;
      for (let f = Math.max(t.from, 1); f <= t.to; f++) {
        if (!readFileSync(frameFile(f)).equals(readFileSync(frameFile(f - 1)))) changed++;
      }
      slide.motion = { changedFrames: changed, frames: span + 1 };
      // 太短的转场（几帧）不判：本来就没几帧可动
      if (span + 1 >= 4 && changed * 2 < span + 1) {
        notes.push(`第 ${slide.index + 1} 页：转场 ${span + 1} 帧里只有 ${changed} 帧在动，多半是跳过去了，看 p${page}-t*.png`);
      }
    }
    const end = path.join(keyDir, `p${page}-end.png`);
    copyFileSync(frameFile(slide.endFrame), end);
    keyframes.push(end);
    slide.keyframes = keyframes;
    delete slide.endFrame;
  }

  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    try {
      execFileSync("ffmpeg", [
        "-v", "error", "-y", "-framerate", String(FPS), "-i", path.join(framesDir, "%05d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", out,
      ]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error(`拼视频要 ffmpeg，系统里没找到。不要视频就去掉 -o，关键帧已经在 ${keyDir}`);
    }
  }
} finally {
  // 出错也要删掉临时帧目录（几百张 1080p 截图），也要关掉浏览器
  await browser?.close().catch(() => {});
  rmSync(framesDir, { recursive: true, force: true });
}
if (jsonOut) {
  mkdirSync(path.dirname(jsonOut), { recursive: true });
  writeFileSync(
    jsonOut,
    JSON.stringify({ version: 1, deck: path.resolve(deck), out, keyframesDir: keyDir, fps: FPS, frames: n, problems, notes, slides }, null, 2),
  );
}

if (problems.length) console.log("\n页面报告的问题：\n" + problems.join("\n"));
if (notes.length) console.log("\n提醒（转场可能没动起来）：\n" + notes.join("\n"));
console.log(`\n${n} 帧，关键帧 → ${keyDir}`);
if (out) console.log(`视频 → ${out}`);
if (jsonOut) console.log(`录制报告 → ${jsonOut}`);
