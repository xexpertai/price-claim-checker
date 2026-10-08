// Dev only: copies the SYNTHETIC fixtures into a temp "recorded" folder so the UI can be exercised
// without a SerpApi key. The UI shows a red SYNTHETIC banner on every result from them.
// Usage: PCC_RECORDED_DIR=/some/tmp/dir tsx scripts/dev-synthetic.ts && PCC_RECORDED_DIR=... PCC_MODE=recorded npm start
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheKey } from "../src/serpapi.js";
import { immersiveParams, shoppingParams } from "../src/pipeline.js";

const dir = process.env.PCC_RECORDED_DIR;
if (!dir || dir.includes("fixtures/recorded")) throw new Error("set PCC_RECORDED_DIR to a temp folder (never fixtures/recorded)");
mkdirSync(dir, { recursive: true });
const syn = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/synthetic/${f}`, import.meta.url), "utf8"));
for (const [params, raw] of [[shoppingParams("Test Kettle 1.5L"), syn("shopping.json")], [immersiveParams("tok-kettle"), syn("immersive.json")]] as const)
  writeFileSync(join(dir, `${cacheKey(params)}.json`), JSON.stringify({ fetchedAt: "2026-10-08T06:00:00Z", params, raw }));
writeFileSync(join(dir, "examples.json"), JSON.stringify([{ label: "SYNTHETIC test kettle", text: "Test Kettle 1.5L at ₹1,299, 50% off, lowest price!", claim: { product: "Test Kettle 1.5L", price: 1299, discountPct: 50, referencePrice: null, claimsLowest: true } }]));
console.log("synthetic recorded dir ready:", dir);
