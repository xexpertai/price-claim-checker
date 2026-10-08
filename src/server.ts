// Tiny HTTP server: static UI + JSON API. No framework, no runtime LLM.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { parseClaim, type Claim } from "./claim.js";
import { RULES } from "./check.js";
import { runCheck } from "./pipeline.js";
import { account, CREDIT_CAP, CreditCapError, defaultMode, findRawBySearchId, hasKey, NotRecordedError, readLedger, RECORDED, ROOT } from "./serpapi.js";

const PORT = Number(process.env.PORT ?? 8787);
const PUB = join(ROOT, "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 20000) throw new Error("request too large"); }
  return s ? JSON.parse(s) : {};
}
function cleanClaim(c: any): Claim {
  const n = (v: any) => (v === "" || v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
  const product = String(c?.product ?? "").slice(0, 160).trim();
  if (!product) throw new Error("Enter a product name.");
  const d = n(c?.discountPct);
  return { product, price: n(c?.price), discountPct: d != null && d < 100 ? d : null, referencePrice: n(c?.referencePrice), claimsLowest: Boolean(c?.claimsLowest) };
}
function examples() {
  const p = join(RECORDED, "examples.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/api/status") {
      const l = readLedger();
      return send(res, 200, { mode: defaultMode(), hasKey: hasKey(), ledger: { credits: l.credits, cap: CREDIT_CAP }, account: await account(), rules: RULES, examples: examples() });
    }
    if (url.pathname === "/api/parse" && req.method === "POST") {
      const b = await body(req);
      return send(res, 200, parseClaim(String(b.text ?? "").slice(0, 600)));
    }
    if (url.pathname === "/api/check" && req.method === "POST") {
      const b = await body(req);
      const mode = b.mode === "recorded" || defaultMode() === "recorded" ? "recorded" : "live";
      const pick = Number.isInteger(b.pick) ? b.pick : null;
      return send(res, 200, await runCheck(cleanClaim(b.claim), { pick, mode }));
    }
    const raw = /^\/api\/raw\/([A-Za-z0-9_-]{6,64})$/.exec(url.pathname);
    if (raw) {
      const j = findRawBySearchId(raw[1]);
      return j ? send(res, 200, j) : send(res, 404, { error: "not found" });
    }
    // static
    const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^([/\\])+/, "");
    const file = join(PUB, rel);
    if (!file.startsWith(PUB) || !existsSync(file)) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (e: any) {
    const code = e instanceof NotRecordedError ? 404 : e instanceof CreditCapError ? 429 : e instanceof SyntaxError || /Enter a product|too large/.test(e?.message) ? 400 : 502;
    send(res, code, { error: e?.message ?? String(e), notRecorded: e instanceof NotRecordedError });
  }
});

const HOST = process.env.HOST ?? "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`Price-Claim Checker on http://${HOST}:${PORT}  (mode: ${defaultMode().toUpperCase()}${hasKey() ? "" : ", no SERPAPI_API_KEY: replaying recorded searches"})`);
});
