// Screenshot helper: node scripts/shot.mjs <url> <out.png> [width] [height] — fills the first example and checks it.
import { chromium } from "playwright";
const [url, out, w = "1280", h = "900"] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
await p.goto(url);
await p.waitForSelector("#exList .chip");
await p.click("#exList .chip");
await p.click("#checkBtn");
await p.waitForSelector(".verdict");
await p.screenshot({ path: out, fullPage: true });
await b.close();
