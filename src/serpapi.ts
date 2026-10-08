// SerpApi access with three sources, always labelled:
//   LIVE      fetched from serpapi.com just now (costs 1 credit unless SerpApi serves its own 1-hour cache)
//   CACHED    a LIVE response fetched earlier on this machine, reused within CACHE_TTL_HOURS (0 credits)
//   RECORDED  a real response saved once to fixtures/recorded/ and replayed (0 credits; used by the demo and when no key is set)
// A local ledger counts every live call and refuses to go past CREDIT_CAP.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokens } from "./offers.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.PCC_DATA_DIR ?? join(ROOT, "data");
const CACHE = join(DATA, "cache");
const LEDGER = join(DATA, "ledger.json");
export const RECORDED = process.env.PCC_RECORDED_DIR ?? join(ROOT, "fixtures", "recorded");
export const CREDIT_CAP = Number(process.env.CREDIT_CAP ?? 150);
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS ?? 6);

export type Source = "LIVE" | "CACHED" | "RECORDED";
export interface Fetched { raw: any; source: Source; key: string; fetchedAt: string; params: Record<string, string> }

function loadEnvLocal(): void {
  const p = join(ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

export const hasKey = () => Boolean(process.env.SERPAPI_API_KEY);
/** "recorded" forces replay even when a key is set (demo, tests). */
export const defaultMode = (): "live" | "recorded" => (process.env.PCC_MODE === "recorded" || !hasKey() ? "recorded" : "live");

export function cacheKey(params: Record<string, string>): string {
  const canon = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return createHash("sha256").update(canon).digest("hex").slice(0, 20);
}

/** Removes the API key from anything that might echo it (defence in depth; SerpApi does not echo it). */
export function redact<T>(raw: T): T {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return raw;
  return JSON.parse(JSON.stringify(raw).split(key).join("[redacted]"));
}

interface Ledger { credits: number; calls: { at: string; engine: string; key: string; searchId: string }[] }
export function readLedger(): Ledger {
  try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return { credits: 0, calls: [] }; }
}
function writeJson(p: string, v: unknown) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 1)); }

export function readRecorded(key: string): Fetched | null {
  const p = join(RECORDED, `${key}.json`);
  if (!existsSync(p)) return null;
  const f = JSON.parse(readFileSync(p, "utf8"));
  return { raw: f.raw, source: "RECORDED", key, fetchedAt: f.fetchedAt, params: f.params };
}

/** Same words in any order, units normalised ("2000 watt induction cooktop" = "induction cooktop 2000W"). */
export const queryKey = (q: string) => [...new Set(tokens(q))].sort().join(" ");

/** Replay lookup that tolerates word order and unit spelling in the search query. */
export function findRecorded(params: Record<string, string>): Fetched | null {
  const exact = readRecorded(cacheKey(params));
  if (exact || !params.q || !existsSync(RECORDED)) return exact;
  const want = queryKey(params.q);
  for (const f of readdirSync(RECORDED)) {
    if (!f.endsWith(".json") || f === "examples.json") continue;
    const j = JSON.parse(readFileSync(join(RECORDED, f), "utf8"));
    const p = j.params ?? {};
    const same = Object.keys(params).every((k) => k === "q" || p[k] === params[k]) && p.q && queryKey(p.q) === want;
    if (same) return { raw: j.raw, source: "RECORDED", key: f.replace(/\.json$/, ""), fetchedAt: j.fetchedAt, params: p };
  }
  return null;
}

export function findRawBySearchId(id: string): any | null {
  for (const dir of [CACHE, RECORDED]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (j?.raw?.search_metadata?.id === id) return j.raw;
    }
  }
  return null;
}

export class CreditCapError extends Error {}
export class NotRecordedError extends Error {}

export async function serpapi(params: Record<string, string>, mode: "live" | "recorded" = defaultMode()): Promise<Fetched> {
  const key = cacheKey(params);
  if (mode === "recorded") {
    const r = findRecorded(params);
    if (!r) throw new NotRecordedError("This search is not among the recorded examples, and this instance makes no live searches.");
    return r;
  }
  const cp = join(CACHE, `${key}.json`);
  if (existsSync(cp)) {
    const c = JSON.parse(readFileSync(cp, "utf8"));
    if (Date.now() - Date.parse(c.fetchedAt) < CACHE_TTL_HOURS * 3600e3) return { raw: c.raw, source: "CACHED", key, fetchedAt: c.fetchedAt, params };
  }
  const recorded = readRecorded(key);
  const ledger = readLedger();
  if (ledger.credits + 1 > CREDIT_CAP) {
    if (recorded) return recorded;
    throw new CreditCapError(`Local credit cap of ${CREDIT_CAP} SerpApi searches reached; raise CREDIT_CAP in .env.local to continue.`);
  }
  const url = new URL("https://serpapi.com/search.json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("api_key", process.env.SERPAPI_API_KEY as string);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  // Count the attempt before parsing: a failed search may still be billed.
  const body = redact(await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
  ledger.credits += 1;
  ledger.calls.push({ at: new Date().toISOString(), engine: params.engine, key, searchId: body?.search_metadata?.id ?? "-" });
  writeJson(LEDGER, ledger);
  if (!res.ok || body.error) throw new Error(`SerpApi ${params.engine}: ${body.error ?? res.status}`);
  const fetchedAt = new Date().toISOString();
  writeJson(cp, { fetchedAt, params, raw: body });
  return { raw: body, source: "LIVE", key, fetchedAt, params };
}

/** Free endpoint (does not use a search credit): remaining searches on the SerpApi plan. */
let accountCache: { at: number; v: any } | null = null;
export async function account(): Promise<{ plan_searches_left?: number; this_month_usage?: number; searches_per_month?: number } | null> {
  if (!hasKey() || process.env.PCC_MODE === "recorded") return null;
  if (accountCache && Date.now() - accountCache.at < 60e3) return accountCache.v;
  try {
    const r = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(process.env.SERPAPI_API_KEY as string)}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const v = { plan_searches_left: j.plan_searches_left ?? j.total_searches_left, this_month_usage: j.this_month_usage, searches_per_month: j.searches_per_month };
    accountCache = { at: Date.now(), v };
    return v;
  } catch { return null; }
}
