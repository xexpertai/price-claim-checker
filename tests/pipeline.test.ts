// End-to-end over SYNTHETIC SerpApi-shaped responses, replayed from a temp "recorded" folder.
// fetch is stubbed to throw, so no test can ever spend a SerpApi credit.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "pcc-"));
process.env.PCC_RECORDED_DIR = join(dir, "recorded");
process.env.PCC_DATA_DIR = join(dir, "data");
vi.stubGlobal("fetch", () => { throw new Error("network disabled in tests"); });

const syn = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/synthetic/${f}`, import.meta.url), "utf8"));

describe("pipeline (synthetic replay)", async () => {
  const { mkdirSync } = await import("node:fs");
  const { cacheKey, serpapi, NotRecordedError, CreditCapError } = await import("../src/serpapi.js");
  const { runCheck, shoppingParams, immersiveParams } = await import("../src/pipeline.js");
  const { shoppingOffers, storeOffers, pickProduct } = await import("../src/offers.js");

  beforeAll(() => {
    mkdirSync(process.env.PCC_RECORDED_DIR!, { recursive: true });
    for (const [params, raw] of [[shoppingParams("Test Kettle 1.5L"), syn("shopping.json")], [immersiveParams("tok-kettle"), syn("immersive.json")]] as const)
      writeFileSync(join(process.env.PCC_RECORDED_DIR!, `${cacheKey(params)}.json`), JSON.stringify({ fetchedAt: "2026-10-08T06:00:00Z", params, raw }));
  });

  it("normalises shopping and store results with receipts", () => {
    const s = shoppingOffers(syn("shopping.json"));
    expect(s).toHaveLength(4);
    expect(s[0]).toMatchObject({ seller: "Shop One", price: 1199, originalPrice: 1999, receipt: { engine: "google_shopping", searchId: "synthetic-shop-0001" } });
    const st = storeOffers(syn("immersive.json"));
    expect(st.map((x) => x.price)).toEqual([1199, 1249, 1299, 1350, 1229]);
  });

  it("picks the best-matching product with a page token (not the accessory or other size)", () => {
    expect(pickProduct("test kettle 1.5l", syn("shopping.json"))).toBe(0);
    expect(pickProduct("completely different thing", syn("shopping.json"))).toBeNull();
  });

  it("normalises units and spots bundles", async () => {
    const { relevance, looksLikeBundle } = await import("../src/offers.js");
    expect(relevance("pressure cooker 5 litre", "Outer Lid Pressure Cooker 5L").score).toBe(1);
    expect(relevance("1.5 litre kettle", "Kettle, 1.5 Ltr").missingModel).toEqual([]);
    expect(looksLikeBundle("Cordial 2L 3L & 5L Pressure Cooker Combo")).toBe(true);
    expect(looksLikeBundle("Insta 5 L Outer Lid Pressure Cooker")).toBe(false);
  });

  it("runs a full check from recorded responses, spending nothing", async () => {
    const r = await runCheck({ product: "Test Kettle 1.5L", price: 1299, discountPct: 50, referencePrice: null, claimsLowest: true }, { mode: "recorded" });
    expect(r.sources.map((s) => [s.engine, s.source])).toEqual([["google_shopping", "RECORDED"], ["google_immersive_product", "RECORDED"]]);
    expect(r.creditsSpent).toBe(0);
    expect(r.report.basis).toBe("same product, several sellers");
    expect(r.report.stats?.n).toBe(4); // Shop One listed twice -> once
    expect(r.report.findings.find((f) => f.id === "lowest")?.status).toBe("fails");
    expect(r.report.verdict.status).toBe("fails");
  });

  it("refuses unrecorded searches in recorded mode", async () => {
    await expect(serpapi(shoppingParams("something else"), "recorded")).rejects.toBeInstanceOf(NotRecordedError);
  });

  it("enforces the local credit cap before any network call", async () => {
    process.env.SERPAPI_API_KEY = "test-key-not-real";
    process.env.CREDIT_CAP = "0";
    vi.resetModules();
    const m = await import("../src/serpapi.js");
    await expect(m.serpapi(shoppingParams("uncached item"), "live")).rejects.toBeInstanceOf(m.CreditCapError);
    delete process.env.SERPAPI_API_KEY;
    expect(CreditCapError).toBeDefined();
  });
});
