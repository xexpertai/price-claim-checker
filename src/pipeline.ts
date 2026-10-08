// One claim check = up to 2 SerpApi searches:
//   1. google_shopping for the product (India: gl=in, google.co.in, INR) -> candidate products and listings
//   2. google_immersive_product for the best-matching candidate (more_stores=true) -> the same product at many sellers
// Then the deterministic checker in check.ts produces the verdict.
import type { Claim } from "./claim.js";
import { checkClaim, selectComparable, type Report } from "./check.js";
import { pickProduct, relevance, shoppingOffers, storeOffers } from "./offers.js";
import { serpapi, defaultMode, type Source } from "./serpapi.js";

export interface SourceRef { engine: string; searchId: string; fetchedAt: string; source: Source; key: string }
export interface Candidate { index: number; title: string; price: number | null; seller: string; multipleSources: boolean; relevance: number }
export interface CheckResult { report: Report; sources: SourceRef[]; product: { title: string; index: number | null; candidates: Candidate[] }; mode: "live" | "recorded"; creditsSpent: number; synthetic: boolean }

export function shoppingParams(product: string): Record<string, string> {
  return { engine: "google_shopping", q: product.trim().toLowerCase(), gl: "in", hl: "en", google_domain: "google.co.in" };
}
export function immersiveParams(pageToken: string): Record<string, string> {
  return { engine: "google_immersive_product", page_token: pageToken, more_stores: "true" };
}

export async function runCheck(claim: Claim, opts: { pick?: number | null; mode?: "live" | "recorded" } = {}): Promise<CheckResult> {
  const mode = opts.mode ?? defaultMode();
  const sources: SourceRef[] = [];
  const ref = (f: Awaited<ReturnType<typeof serpapi>>, engine: string): SourceRef => ({
    engine, searchId: f.raw?.search_metadata?.id ?? "unknown", fetchedAt: f.raw?.search_metadata?.processed_at ?? f.fetchedAt, source: f.source, key: f.key,
  });

  let synthetic = false;
  const shop = await serpapi(shoppingParams(claim.product), mode);
  synthetic ||= Boolean(shop.raw?._synthetic);
  sources.push(ref(shop, "google_shopping"));
  const items: any[] = shop.raw?.shopping_results ?? [];
  const candidates: Candidate[] = items
    .map((r, index) => ({ index, title: String(r.title ?? ""), price: r.extracted_price ?? null, seller: String(r.source ?? ""), multipleSources: Boolean(r.multiple_sources), relevance: relevance(claim.product, String(r.title ?? "")).score, token: r.immersive_product_page_token }))
    .filter((c) => c.token)
    .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
    .slice(0, 6)
    .map(({ token: _t, ...c }) => c);

  const index = opts.pick != null && items[opts.pick]?.immersive_product_page_token ? opts.pick : pickProduct(claim.product, shop.raw);
  let stores: ReturnType<typeof storeOffers> = [];
  let title = "";
  if (index != null) {
    title = String(items[index].title ?? "");
    const imm = await serpapi(immersiveParams(items[index].immersive_product_page_token), mode);
    sources.push(ref(imm, "google_immersive_product"));
    synthetic ||= Boolean(imm.raw?._synthetic);
    stores = storeOffers(imm.raw);
    title = String(imm.raw?.product_results?.title ?? title);
  }
  const sel = selectComparable(claim.product, stores, shoppingOffers(shop.raw));
  const report = checkClaim(claim, sel.comparable, sel.excluded, sel.basis);
  return { report, sources, product: { title, index, candidates }, mode, creditsSpent: sources.filter((s) => s.source === "LIVE").length, synthetic };
}
