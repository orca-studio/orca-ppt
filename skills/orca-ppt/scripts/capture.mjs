// 把一份演示稿逐帧录成视频：每帧 seek 到确定时刻再截图，不依赖真实时间。
// 用法：node scripts/capture.mjs <deck.html> [-o out.mp4] [--fps 30] [--json report.json] [--interrupt 页号@毫秒]
// 每页的停留时长读 <section data-hold="秒">，默认 1.5。
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
import { mkdirSync, rmSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("-") && !["-o", "--fps", "--json", "--interrupt"].includes(args[i - 1]));
const deck = positional[0];
if (!deck) {
  console.error("用法：node scripts/capture.mjs <deck.html> [-o out.mp4] [--fps 30]");
  process.exit(1);
}
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const FPS = +opt("--fps", 30);
const out = path.resolve(opt("-o", deck.replace(/\.html?$/, "") + ".mp4"));
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
const framePath = () => path.join(framesDir, String(n++).padStart(5, "0") + ".png");

// seek 后直接截图：截图本身会触发样式计算和绘制。实测在 seek 后多等两帧，录出的每一帧逐位不变
const seek = (ms) => page.evaluate((t) => window.__capture.seek(t), ms);

let browser;
let page;
const problems = [];
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
    });
    const range = frames ? `，转场帧 ${firstFrame}–${firstFrame + frames - 1}` : "";
    const sceneNote = scene ? `，场景动画 ${(scene / 1000).toFixed(2)}s` : "";
    const videoNote = video ? `，视频 ${(video / 1000).toFixed(2)}s` : "";
    console.log(`第 ${i + 1} 页：转场 ${(transition / 1000).toFixed(2)}s，停留 ${(hold / 1000).toFixed(1)}s${range}${sceneNote}${videoNote}`);
  }
  await browser.close();
  browser = null;

  mkdirSync(path.dirname(out), { recursive: true });
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-framerate", String(FPS), "-i", path.join(framesDir, "%05d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", out,
  ]);
} finally {
  // 出错也要删掉临时帧目录（几百张 1080p 截图），也要关掉浏览器
  await browser?.close().catch(() => {});
  rmSync(framesDir, { recursive: true, force: true });
}
if (jsonOut) {
  mkdirSync(path.dirname(jsonOut), { recursive: true });
  writeFileSync(
    jsonOut,
    JSON.stringify({ version: 1, deck: path.resolve(deck), out, fps: FPS, frames: n, problems, slides }, null, 2),
  );
}

if (problems.length) console.log("\n页面报告的问题：\n" + problems.join("\n"));
console.log(`\n${n} 帧 → ${out}`);
if (jsonOut) console.log(`录制报告 → ${jsonOut}`);
