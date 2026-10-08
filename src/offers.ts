// Turns raw SerpApi JSON (google_shopping, google_immersive_product) into flat, traceable offers.
// Every offer keeps the SerpApi search id, engine and fetch time so the UI can show a receipt.

export interface Receipt {
  engine: string;          // "google_shopping" | "google_immersive_product"
  searchId: string;        // search_metadata.id
  fetchedAt: string;       // search_metadata.processed_at / created_at (UTC)
  googleUrl?: string;      // search_metadata.google_shopping_url etc. (no API key in it)
}

export interface Offer {
  seller: string;
  title: string;
  price: number;                  // INR, as extracted by SerpApi
  originalPrice: number | null;   // seller's own strike-through / "was" price, if listed
  link: string | null;            // seller or Google product listing
  receipt: Receipt;
}

export interface Excluded { offer: Offer; reason: string }

type Json = Record<string, any>;

export function receiptOf(raw: Json, engine: string): Receipt {
  const md = raw?.search_metadata ?? {};
  const googleUrl = md.google_shopping_url || md.google_immersive_product_url || md.google_url || undefined;
  return {
    engine,
    searchId: String(md.id ?? "unknown"),
    fetchedAt: String(md.processed_at ?? md.created_at ?? ""),
    googleUrl,
  };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** Seller's strike-through price. SerpApi's old_price can read "22% off₹1,125" (extracted_old_price is then 22,
 * the percentage), "Was ₹2,498" or "₹2,000": take the last rupee amount in the string. */
export function oldPrice(r: Json, price = 0): number | null {
  const v = oldPriceRaw(r);
  return v != null && v > price ? v : null; // a "was" price at or below the price says nothing
}
function oldPriceRaw(r: Json): number | null {
  if (typeof r.old_price === "string") {
    const all = [...r.old_price.matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)];
    if (all.length) return num(all[all.length - 1][1]);
    if (/%/.test(r.old_price)) return null;
  }
  return num(r.extracted_old_price);
}

/** Listings from a google_shopping search (each a different product or seller). */
export function shoppingOffers(raw: Json): Offer[] {
  const receipt = receiptOf(raw, "google_shopping");
  const items: Json[] = [...(raw?.shopping_results ?? []), ...(raw?.inline_shopping_results ?? [])];
  const out: Offer[] = [];
  for (const r of items) {
    const price = num(r.extracted_price) ?? num(r.price);
    if (!price) continue;
    out.push({
      seller: String(r.source ?? "Unknown seller"),
      title: String(r.title ?? ""),
      price,
      originalPrice: oldPrice(r, price),
      link: r.product_link ?? r.link ?? null,
      receipt,
    });
  }
  return out;
}

/** Stores selling one specific product, from a google_immersive_product search. */
export function storeOffers(raw: Json): Offer[] {
  const receipt = receiptOf(raw, "google_immersive_product");
  const pr = raw?.product_results ?? {};
  const out: Offer[] = [];
  for (const s of pr.stores ?? []) {
    const price = num(s.extracted_price) ?? num(s.price);
    if (!price) continue;
    out.push({
      seller: String(s.name ?? "Unknown seller"),
      title: String(s.title ?? pr.title ?? ""),
      price,
      originalPrice: oldPrice({ old_price: s.original_price, extracted_old_price: s.extracted_original_price }, price),
      link: s.link ?? null,
      receipt,
    });
  }
  return out;
}

const STOP = new Set(["the", "a", "an", "and", "or", "for", "with", "of", "in", "to", "by", "new", "pack", "combo", "set", "pcs", "piece", "pieces", "inch", "x"]);

// "1.5 Litre", "1.5L", "1.5 ltr" -> "1.5l"; same for kg, g, ml, gb, tb, inch, w, mah.
const UNITS: [RegExp, string][] = [
  [/(\d+(?:\.\d+)?)\s*(?:litres?|liters?|ltrs?|lt|l)\b/g, "$1l"],
  [/(\d+(?:\.\d+)?)\s*(?:millilitres?|milliliters?|ml)\b/g, "$1ml"],
  [/(\d+(?:\.\d+)?)\s*(?:kilograms?|kgs?)\b/g, "$1kg"],
  [/(\d+(?:\.\d+)?)\s*(?:grams?|gms?|g)\b/g, "$1g"],
  [/(\d+(?:\.\d+)?)\s*(?:gb)\b/g, "$1gb"],
  [/(\d+(?:\.\d+)?)\s*(?:tb)\b/g, "$1tb"],
  [/(\d+(?:\.\d+)?)\s*(?:inches|inch|in|")(?=\s|$|[^a-z])/g, "$1in"],
  [/(\d+(?:\.\d+)?)\s*(?:watts?|w)\b/g, "$1w"],
  [/(\d+(?:\.\d+)?)\s*(?:mah)\b/g, "$1mah"],
];
export function normaliseUnits(s: string): string {
  let t = s.toLowerCase();
  // Shared unit in a list: "2, 3 & 5 litres" / "2/3/5 l" -> "2litres 3litres 5litres" (then normalised below).
  const list = /(\d+(?:\.\d+)?)\s*(?:,|&|\band\b|\/|\+)\s*(\d+(?:\.\d+)?)\s*(litres?|liters?|ltrs?|lt|l|ml|kgs?|kg|g|gb|tb)\b/;
  for (let i = 0; i < 8 && list.test(t); i++) t = t.replace(list, "$1$3 $2$3");
  for (const [re, rep] of UNITS) t = t.replace(re, rep);
  return t;
}

export function tokens(s: string): string[] {
  return normaliseUnits(s).replace(/[^a-z0-9.\s]/g, " ").split(/\s+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter((w) => w && !STOP.has(w));
}

/** Share of query tokens found in the title; model-number-like tokens (with digits) are mandatory. */
const SPEC = /^(\d+(?:\.\d+)?)(l|ml|kg|g|gb|tb|in|w|mah)$/;
/** A token that identifies the product: has a digit, and a letter or 3+ characters ("gc1011", "16.0", "5l"; not "01"). */
const isModelToken = (w: string) => /\d/.test(w) && (/[a-z]/.test(w) || w.length >= 3);
const compact = (s: string) => normaliseUnits(s).replace(/[^a-z0-9.]/g, "");

/** Share of query words found in the title, plus which model and size tokens are missing. */
export function relevance(query: string, title: string): { score: number; missingModel: string[]; missingId: string[]; conflictingSpec: string[] } {
  const q = [...new Set(tokens(query))];
  if (!q.length) return { score: 1, missingModel: [], missingId: [], conflictingSpec: [] };
  const t = tokens(title);
  const flat = compact(title);
  const has = (w: string) => t.some((x) => x === w || (w.length >= 4 && x.startsWith(w)) || (x.length >= 4 && w.startsWith(x))) || (isModelToken(w) && w.length >= 4 && flat.includes(w));
  const hit = q.filter(has);
  const missingModel = q.filter((w) => isModelToken(w) && !has(w));
  const missingId = missingModel.filter((w) => !SPEC.test(w));
  // A size/power the title states differently ("5.5l" where the claim says "5l").
  const titleSpecs = t.map((x) => SPEC.exec(x)).filter(Boolean) as RegExpExecArray[];
  const conflictingSpec = missingModel.filter((w) => {
    const m = SPEC.exec(w);
    return m && titleSpecs.some((x) => x[2] === m[2] && x[1] !== m[1]) && !titleSpecs.some((x) => x[0] === w);
  });
  return { score: hit.length / q.length, missingModel, missingId, conflictingSpec };
}

/** Why a store row from Google's product page should not count as "this model", or null if it should. */
export function storeMismatch(query: string, storeTitle: string): string | null {
  if (!storeTitle.trim()) return null; // no title: trust Google's grouping
  const r = relevance(query, storeTitle);
  const shown = storeTitle.length > 60 ? storeTitle.slice(0, 57) + "…" : storeTitle;
  if (r.missingId.length) return `store title does not name model "${r.missingId.join(", ")}" (“${shown}”)`;
  if (r.conflictingSpec.length) return `store title states a different size/spec than "${r.conflictingSpec.join(", ")}" (“${shown}”)`;
  if (r.score < 0.5) return `store title matches only ${Math.round(r.score * 100)}% of the product words: likely a different model (“${shown}”)`;
  return null;
}

/** Combos, multi-packs and bundles ("2L 3L & 5L", "combo", "pack of 2", "+") are poor references for one product. */
export function looksLikeBundle(title: string): boolean {
  const t = normaliseUnits(title);
  const sizes = new Set(t.match(/\b\d+(?:\.\d+)?(?:l|ml|kg|g)\b/g) ?? []);
  return sizes.size > 1 || /\b(combo|pack of|set of|bundle|\d+\s*pcs)\b|\+/i.test(t);
}

/** A listing for an accessory of the product ("case cover compatible with X") rather than X itself. */
export function looksLikeAccessory(query: string, title: string): boolean {
  return !/\b(case|cover|compatible|skin|for|guard)\b/i.test(query) && /\b(compatible with|case|cover|skin|screen guard|tempered|replacement)\b/i.test(title);
}

/** Index of the shopping result that best matches the query and can be opened in the immersive view. */
export function pickProduct(query: string, raw: Json): number | null {
  const items: Json[] = raw?.shopping_results ?? [];
  let best: number | null = null;
  let bestScore = -1;
  const wantBundle = looksLikeBundle(query);
  items.forEach((r, i) => {
    if (!r.immersive_product_page_token) return;
    const { score, missingModel } = relevance(query, String(r.title ?? ""));
    const title = String(r.title ?? "");
    // A missing name word (0.2 for a 5-word query) outweighs the several-stores bonus; accessories "for"/"compatible with" the product lose.
    const accessory = looksLikeAccessory(query, title) ? 0.6 : 0;
    const s = score - missingModel.length * 0.5 + (r.multiple_sources ? 0.15 : 0) - (!wantBundle && looksLikeBundle(title) ? 0.4 : 0) - accessory - i * 0.001; // prefer single products Google lists at several stores
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return bestScore >= 0.6 ? best : null;
}
