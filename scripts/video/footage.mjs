// Records the demo footage from the REAL app (recorded mode, store names anonymised) with Playwright at 1920x1080.
// Each story line's actions start when its narration starts; the script then holds until the line's audio ends.
// Writes <build>/footage.webm and <build>/timeline.json (line start times relative to the video start).
// Usage: node scripts/video/footage.mjs video/story.json video/build http://127.0.0.1:8791
import { chromium } from "playwright";
import { readFileSync, readdirSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [storyPath, build, base] = process.argv.slice(2);
const story = JSON.parse(readFileSync(storyPath, "utf8"));
const durs = JSON.parse(readFileSync(join(build, "durations.json"), "utf8"));
const GAP = story.gap ?? 0.25;

// Guard: the demo must never show synthetic data.
for (const f of readdirSync("fixtures/recorded")) if (readFileSync(join("fixtures/recorded", f), "utf8").includes("_synthetic")) throw new Error(`synthetic data in fixtures/recorded/${f}`);
const status = await (await fetch(base + "/api/status")).json();
if (status.mode !== "recorded") throw new Error("start the server with PCC_MODE=recorded for the demo");

const vdir = join(build, "raw-video"); mkdirSync(vdir, { recursive: true });
const browser = await chromium.launch();
// The app area is 1920x940; assemble.py adds a 140 px caption bar below it, so captions never cover the app.
const H = 940;
const ctx = await browser.newContext({ viewport: { width: 1920, height: H }, recordVideo: { dir: vdir, size: { width: 1920, height: H } } });
const t0 = Date.now();
const page = await ctx.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cards = pathToFileURL(resolve("video/cards.html")).href;
const ZOOM = story.zoom ?? 1.45;

// Zoom and highlight styles are injected before first paint (no unzoomed flash), on app pages only.
await ctx.addInitScript((zoom) => {
  if (location.protocol !== "http:") return;
  const add = () => { const st = document.createElement("style"); st.textContent = `html{zoom:${zoom}} .pcc-hl{outline:4px solid #f59e0b !important;outline-offset:3px;border-radius:8px} html{scroll-behavior:smooth} body{padding-bottom:120px}`; document.documentElement.appendChild(st); };
  document.documentElement ? add() : document.addEventListener("DOMContentLoaded", add);
}, ZOOM);
async function prep() {}
// One persistent highlight at a time, so the viewer always sees what the narration is about.
async function hl(sel) {
  await page.evaluate((s) => { document.querySelectorAll(".pcc-hl").forEach((x) => x.classList.remove("pcc-hl")); document.querySelector(s)?.classList.add("pcc-hl"); }, sel);
}
async function scrollTo(sel, block = "start") {
  await page.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: b }), [sel, block]);
  await sleep(900);
}
const ACTIONS = {
  card: async (name) => { await page.goto(`${cards}?card=${name}`); },
  app: async () => { await page.goto(base + "/?anon=1"); await prep(); await page.waitForSelector("#exList .chip"); },
  type: async (sel, text) => { await hl(sel); await page.click(sel); await page.fill(sel, ""); await page.type(sel, text, { delay: 22 }); },
  click: async (sel) => { await hl(sel); await sleep(450); await page.click(sel); },
  clickText: async (text) => { const l = page.getByText(text, { exact: false }).first(); await l.scrollIntoViewIfNeeded(); await l.evaluate((e) => { document.querySelectorAll(".pcc-hl").forEach((x) => x.classList.remove("pcc-hl")); e.classList.add("pcc-hl"); }); await sleep(450); await l.click(); },
  waitFor: async (sel) => { await page.waitForSelector(sel); },
  scrollTo: async (sel, block) => scrollTo(sel, block),
  scrollBy: async (px) => { await page.evaluate((y) => window.scrollBy({ top: y, behavior: "smooth" }), px); await sleep(900); },
  top: async () => { await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await sleep(900); },
  highlight: async (sel) => { await hl(sel); },
  open: async (sel) => { await page.evaluate((s) => { const d = document.querySelector(s); if (d) d.open = true; }, sel); await sleep(300); },
  wait: async (ms) => sleep(ms),
};

const timeline = [];
await page.goto(`${cards}?card=blank`);
await sleep(600);
for (const ln of story.lines) {
  const start = (Date.now() - t0) / 1000;
  timeline.push({ id: ln.id, start });
  const target = start + durs[ln.id] + (ln.gap ?? GAP);
  for (const [name, ...args] of ln.do ?? []) {
    if (!ACTIONS[name]) throw new Error("unknown action " + name);
    await ACTIONS[name](...args);
  }
  if (!process.env.ALLOW_SYNTHETIC && /SYNTHETIC/i.test(await page.content())) throw new Error(`synthetic data visible at line ${ln.id}: aborting`);
  const left = target - (Date.now() - t0) / 1000;
  if (left > 0) await sleep(left * 1000);
  else console.warn(`line ${ln.id}: actions overran narration by ${(-left).toFixed(2)} s`);
}
await sleep((story.tail ?? 0.4) * 1000);
const end = (Date.now() - t0) / 1000;
const vpath = await page.video().path();
await ctx.close(); await browser.close();
renameSync(vpath, join(build, "footage.webm"));
writeFileSync(join(build, "timeline.json"), JSON.stringify({ lines: timeline, end }, null, 1));
console.log(`footage ${end.toFixed(1)} s, ${timeline.length} lines`);
