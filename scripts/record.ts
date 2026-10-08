// Records real SerpApi responses for the demo/replay. Spends credits (2 per product, 0 if cached).
// Usage: npm run record -- "product query" ["another query" ...]       (needs SERPAPI_API_KEY in .env.local)
//        npm run record -- --pick 3 "product query"                      (record another candidate product)
// Responses go to fixtures/recorded/<cache key>.json (API key redacted). Then add the example claim to
// fixtures/recorded/examples.json by hand.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "../src/pipeline.js";
import { hasKey, readLedger, RECORDED, CREDIT_CAP } from "../src/serpapi.js";

if (!hasKey()) { console.error("SERPAPI_API_KEY missing in .env.local"); process.exit(1); }
const args = process.argv.slice(2);
let pick: number | null = null;
const queries: string[] = [];
for (let i = 0; i < args.length; i++) args[i] === "--pick" ? (pick = Number(args[++i])) : queries.push(args[i]);
mkdirSync(RECORDED, { recursive: true });
const cacheDir = join(process.env.PCC_DATA_DIR ?? join(RECORDED, "..", "..", "data"), "cache");
for (const q of queries) {
  const r = await runCheck({ product: q, price: null, discountPct: null, referencePrice: null, claimsLowest: false }, { mode: "live", pick });
  for (const s of r.sources) {
    const src = join(cacheDir, `${s.key}.json`);
    if (existsSync(src)) copyFileSync(src, join(RECORDED, `${s.key}.json`));
  }
  const st = r.report.stats;
  console.log(`\n${q}\n  product: ${r.product.title || "(none picked)"}  [index ${r.product.index}]`);
  console.log(`  sources: ${r.sources.map((s) => `${s.engine}:${s.source}:${s.searchId}`).join("  ")}`);
  console.log(`  ${r.report.basis}: n=${st?.n ?? 0}` + (st ? ` min=${st.min} median=${st.median} max=${st.max}` : ""));
  for (const o of r.report.comparable) console.log(`    ${o.price}\t${o.originalPrice ?? "-"}\t${o.seller}`);
  if (r.report.excluded.length) console.log(`  excluded: ${r.report.excluded.length}`);
  console.log(`  candidates:`); for (const c of r.product.candidates) console.log(`    [${c.index}] ${c.price} ${c.seller} | ${c.title.slice(0, 70)} (rel ${c.relevance.toFixed(2)}${c.multipleSources ? ", multi" : ""})`);
}
console.log(`\nledger: ${readLedger().credits}/${CREDIT_CAP} credits used by this project`);
