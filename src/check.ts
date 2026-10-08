// The claim checker. Pure, deterministic functions: same inputs -> same verdict. No LLM, no network.
// Every number in a finding carries the offer it came from, so the UI can link it to its receipt.
import type { Claim } from "./claim.js";
import { looksLikeAccessory, relevance, storeMismatch, type Excluded, type Offer } from "./offers.js";

export const RULES = {
  minComparable: 2,          // fewer comparable sellers than this -> "insufficient"
  lowestTolerance: 0.01,     // claimed price may be up to 1% above the cheapest seller and still count as lowest
  discountSlackPts: 5,       // claimed % off may exceed the real saving vs median by up to 5 points
  meaningfulSavingPct: 5,    // below this real saving vs median, a discount claim fails outright
  referenceMatch: 0.03,      // a seller's listed "was" price within 3% corroborates the claimed MRP
  referenceNearMax: 0.05,    // ...or at least `referenceMinSellers` sellers charging it (within 5%) or more
  referenceMinSellers: 2,    // one outlier seller alone does not make an MRP real
  minRelevance: 0.6,         // share of query words a similar listing's title must contain
  outlierLow: 0.35,          // listing below 35% of the median -> likely accessory/part
  outlierHigh: 3,            // listing above 3x the median -> likely bundle/different item
} as const;

export type Status = "info" | "holds" | "unverified" | "overstated" | "fails" | "insufficient";
const SEVERITY: Record<Status, number> = { info: 0, holds: 0, unverified: 1, overstated: 2, fails: 3, insufficient: 4 };

export interface Num { label: string; value: number; unit: "inr" | "pct"; offer?: Offer }
export interface Finding { id: "lowest" | "discount" | "reference" | "price"; status: Status; label?: string; title: string; detail: string; numbers: Num[] }
export interface Stats { n: number; min: number; median: number; max: number; spreadPct: number; cheapest: Offer; priciest: Offer }
export interface Report {
  claim: Claim;
  basis: "same product, several sellers" | "top match's store list" | "similar listings" | "none";
  comparable: Offer[];
  excluded: Excluded[];
  stats: Stats | null;
  findings: Finding[];
  verdict: { status: Status; headline: string };
}

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number) => Math.round(x * 10) / 10;
const inr = (x: number) => "₹" + Math.round(x).toLocaleString("en-IN");

/** One key per merchant: "Myntra" and "Myntra - MNow" are the same merchant. */
export const sellerKey = (name: string) => name.toLowerCase().split(/\s+[-–|]\s+/)[0].replace(/\s+/g, " ").trim();

const FOREIGN_TLD = /\.(ae|uk|us|sg|au|ca|sa|qa|om|kw|bh|my|cn|hk|de|fr|jp|nz|pk|bd|lk|np)$/i;
/** Sellers that are evidently outside India (foreign domain or country in the store name). */
export function foreignSeller(o: Offer): string | null {
  const name = o.seller.toLowerCase();
  if (/tradeindia|indiamart|aajjo|exportersindia|udaan/.test(name)) return "B2B / wholesale marketplace, not a retail price";
  const tld = /\.([a-z]{2})\b/.exec(name);
  if (tld && FOREIGN_TLD.test("." + tld[1])) return `.${tld[1]} store`;
  if (/united kingdom|\buae\b|dubai|\busa\b|united states/.test(name)) return "store name says outside India";
  try {
    const host = o.link ? new URL(o.link).hostname : "";
    const m = FOREIGN_TLD.exec(host);
    if (m && !/google\./.test(host)) return `.${m[1]} website`;
  } catch { /* not a URL */ }
  return null;
}

/** Cheapest offer per merchant (a merchant listed twice counts once). */
export function dedupeBySeller(offers: Offer[], excluded?: Excluded[]): Offer[] {
  const by = new Map<string, Offer>();
  for (const o of offers) {
    const k = sellerKey(o.seller);
    const cur = by.get(k);
    if (!cur || o.price < cur.price) {
      if (cur) excluded?.push({ offer: cur, reason: `same merchant as ${o.seller} (${inr(o.price)}); the lower-priced listing is kept` });
      by.set(k, o);
    } else excluded?.push({ offer: o, reason: `same merchant as ${cur.seller} (${inr(cur.price)}); the lower-priced listing is kept` });
  }
  return [...by.values()].sort((a, b) => a.price - b.price);
}

/** Picks the offers to compare against and records why the rest were left out. */
export function selectComparable(query: string, storeOffers: Offer[], shoppingOffers: Offer[]): { basis: Report["basis"]; comparable: Offer[]; excluded: Excluded[] } {
  const excluded: Excluded[] = [];
  let basis: Report["basis"];
  let pool: Offer[];
  const india = (list: Offer[]) => list.filter((o) => {
    const why = foreignSeller(o);
    if (why) excluded.push({ offer: o, reason: why.startsWith("B2B") ? why : `seller appears to be outside India (${why})` });
    return !why;
  });
  // Google groups store rows under one product, but a row can be a sibling model: check each store's own title.
  const stores = dedupeBySeller(india(storeOffers).filter((o) => {
    const why = storeMismatch(query, o.title);
    if (why) excluded.push({ offer: o, reason: why });
    return !why;
  }), excluded);
  shoppingOffers = india(shoppingOffers);
  if (stores.length >= RULES.minComparable) {
    basis = "same product, several sellers";
    pool = stores;
  } else {
    basis = "similar listings";
    pool = [];
    for (const o of shoppingOffers) {
      const r = relevance(query, o.title);
      if (looksLikeAccessory(query, o.title)) excluded.push({ offer: o, reason: "an accessory for the product (case, cover, “compatible with”), not the product" });
      else if (r.missingModel.length) excluded.push({ offer: o, reason: `title lacks model/size "${r.missingModel.join(", ")}"` });
      else if (r.score < RULES.minRelevance) excluded.push({ offer: o, reason: `title matches only ${Math.round(r.score * 100)}% of the product words` });
      else pool.push(o);
    }
    pool = dedupeBySeller([...stores, ...pool], excluded);
  }
  if (pool.length >= 3) {
    const med = median(pool.map((o) => o.price));
    const kept: Offer[] = [];
    for (const o of pool) {
      if (o.price < med * RULES.outlierLow) excluded.push({ offer: o, reason: `price under ${RULES.outlierLow * 100}% of the median (${inr(med)}): likely an accessory or part` });
      else if (o.price > med * RULES.outlierHigh) excluded.push({ offer: o, reason: `price over ${RULES.outlierHigh}x the median (${inr(med)}): likely a bundle or different item` });
      else kept.push(o);
    }
    pool = kept;
  }
  if (basis === "similar listings" && pool.length && pool.every((o) => o.receipt.engine === "google_immersive_product")) basis = "top match's store list";
  if (!pool.length) basis = "none";
  return { basis, comparable: pool, excluded };
}

export function stats(offers: Offer[]): Stats | null {
  if (!offers.length) return null;
  const s = [...offers].sort((a, b) => a.price - b.price);
  const min = s[0].price, max = s[s.length - 1].price;
  return { n: s.length, min, max, median: median(s.map((o) => o.price)), spreadPct: pct(((max - min) / min) * 100), cheapest: s[0], priciest: s[s.length - 1] };
}

/** Claimed discount in %, from the explicit "% off" or from price vs claimed MRP. */
export function claimedDiscount(c: Claim): number | null {
  if (c.discountPct != null) return c.discountPct;
  if (c.price != null && c.referencePrice != null && c.referencePrice > c.price) return pct((1 - c.price / c.referencePrice) * 100);
  return null;
}

/** Claimed MRP, explicit or implied by price and % off. */
export function claimedReference(c: Claim): { value: number; implied: boolean } | null {
  if (c.referencePrice != null) return { value: c.referencePrice, implied: false };
  if (c.price != null && c.discountPct != null && c.discountPct > 0 && c.discountPct < 100) return { value: Math.round(c.price / (1 - c.discountPct / 100)), implied: true };
  return null;
}

export function checkClaim(claim: Claim, comparableIn: Offer[], excluded: Excluded[] = [], basis: Report["basis"] = "same product, several sellers"): Report {
  const comparable = [...comparableIn].sort((a, b) => a.price - b.price);
  const st = stats(comparable);
  const findings: Finding[] = [];
  const P = claim.price;

  if (!st || st.n < RULES.minComparable || P == null) {
    const bulk = P != null && st && st.n === 1 && st.min > P * 3 ? ` The only listing found (${inr(st.min)}, ${st.cheapest.seller}) is more than 3× the claimed price: likely a bulk or wholesale listing, not a retail price.` : "";
    const none = `No comparable seller found: every listing was left out (see the reasons: accessories, other models, wholesale or non-India sellers).`;
    const why = P == null ? "No claimed price was found in the text; enter it to run the checks." : !st ? none : `Only ${st.n} comparable seller${st.n === 1 ? "" : "s"} found; at least ${RULES.minComparable} are needed for a fair comparison.${bulk}`;
    return { claim, basis, comparable, excluded, stats: st, findings, verdict: { status: "insufficient", headline: "Not enough data to judge" + (P == null ? "" : " this claim") + ". " + why } };
  }

  // 1. Where the claimed price sits in today's market.
  const below = comparable.filter((o) => o.price < P).length;
  findings.push({
    id: "price",
    status: P < st.min * (1 - 0.03) ? "unverified" : "info",
    title: "Claimed price vs sellers at fetch time",
    detail: P < st.min * 0.97
      ? `${inr(P)} is below every observed seller (cheapest ${inr(st.min)}). It may need a coupon or bank offer, or the deal may have ended.`
      : `${below} of ${st.n} sellers are cheaper than ${inr(P)}. Observed range ${inr(st.min)}–${inr(st.max)}, median ${inr(st.median)}.`,
    numbers: [
      { label: "claimed", value: P, unit: "inr" },
      { label: "cheapest", value: st.min, unit: "inr", offer: st.cheapest },
      { label: "median", value: st.median, unit: "inr" },
      { label: "highest", value: st.max, unit: "inr", offer: st.priciest },
    ],
  });

  // 2. "Lowest price" claims.
  if (claim.claimsLowest) {
    const ok = P <= st.min * (1 + RULES.lowestTolerance);
    findings.push({
      id: "lowest",
      status: ok ? "holds" : "fails",
      title: "“Lowest price” claim",
      detail: ok
        ? `No observed seller is cheaper than ${inr(P)} (cheapest seen: ${inr(st.min)} at ${st.cheapest.seller}).`
        : `${st.cheapest.seller} sells it for ${inr(st.min)}, ${inr(P - st.min)} less than the claimed ${inr(P)}.`,
      numbers: [{ label: "cheapest seen", value: st.min, unit: "inr", offer: st.cheapest }, ...(P > st.min ? [{ label: "difference", value: P - st.min, unit: "inr" as const }] : [])],
    });
  }

  // 3. "% off" claims, measured against what sellers actually charge (median), not against MRP.
  const d = claimedDiscount(claim);
  if (d != null) {
    const real = pct(((st.median - P) / st.median) * 100);
    const status: Status = real >= d - RULES.discountSlackPts ? "holds" : real >= RULES.meaningfulSavingPct ? "overstated" : "fails";
    findings.push({
      id: "discount",
      status,
      // "45% off the MRP" can be arithmetically true; what fails is the saving against what sellers charge.
      ...(status === "fails" ? { label: "No real saving" } : {}),
      title: `“${d}% off” vs the typical market price`,
      detail: status === "holds"
        ? `Against the median seller price of ${inr(st.median)}, the real saving is ${real}%, in line with the claimed ${d}%.`
        : status === "overstated"
          ? `Against the median seller price of ${inr(st.median)}, the real saving is ${real}%, not ${d}%.`
          : real <= 0
            ? `The claimed price is ${real === 0 ? "equal to" : `${pct(-real)}% above`} the median seller price of ${inr(st.median)}: there is no real saving against the market.`
            : `Against the median seller price of ${inr(st.median)}, the real saving is only ${real}%, not ${d}%.`,
      numbers: [{ label: "claimed off", value: d, unit: "pct" }, { label: "real saving vs median", value: real, unit: "pct" }, { label: "median", value: st.median, unit: "inr" }],
    });
  }

  // 4. The MRP / "was" price the discount is computed from: does any seller list or charge it?
  const ref = claimedReference(claim);
  if (ref) {
    const listed = comparable.filter((o) => o.originalPrice != null);
    const match = listed.find((o) => Math.abs((o.originalPrice as number) - ref.value) / ref.value <= RULES.referenceMatch);
    const chargers = comparable.filter((o) => o.price >= ref.value * (1 - RULES.referenceNearMax));
    const charged = chargers.length >= RULES.referenceMinSellers;
    const highestListed = listed.reduce<Offer | null>((m, o) => (!m || (o.originalPrice as number) > (m.originalPrice as number) ? o : m), null);
    const label = ref.implied ? `implied “was” price ${inr(ref.value)}` : `claimed MRP ${inr(ref.value)}`;
    findings.push({
      id: "reference",
      status: match || charged ? "holds" : "unverified",
      title: `Reference price (${ref.implied ? "implied by the % off" : "MRP / was price"})`,
      detail: match
        ? `${match.seller} also lists ${inr(match.originalPrice as number)} as its original price, which matches the ${label}.`
        : charged
          ? `${chargers.length} sellers actually charge about the ${label} or more (e.g. ${chargers[chargers.length - 1].seller} at ${inr(chargers[chargers.length - 1].price)}).`
          : `${chargers.length === 1 ? `Only one seller (${chargers[0].seller}, ${inr(chargers[0].price)}) charges` : "No seller in this snapshot charges"} the ${label} or more, and no seller lists it as an original price. Highest price charged: ${inr(st.max)}` +
            (highestListed ? `; highest listed original price: ${inr(highestListed.originalPrice as number)} (${highestListed.seller}).` : "; no seller lists an original price.") +
            " An MRP can be legitimate even if nobody charges it, so this is flagged, not failed.",
      numbers: [
        { label: ref.implied ? "implied was price" : "claimed MRP", value: ref.value, unit: "inr" },
        { label: "highest charged", value: st.max, unit: "inr", offer: st.priciest },
        ...(highestListed ? [{ label: "highest listed original", value: highestListed.originalPrice as number, unit: "inr" as const, offer: highestListed }] : []),
      ],
    });
  }

  if (findings.length === 1 && findings[0].status === "info")
    return { claim, basis, comparable, excluded, stats: st, findings, verdict: { status: "info", headline: "Only a price was given. Add the claimed % off, MRP or a “lowest price” claim to test it." } };
  const worst = findings.reduce<Status>((w, f) => (SEVERITY[f.status] > SEVERITY[w] ? f.status : w), "holds");
  const headline = {
    info: "Claim holds up against seller prices at fetch time.",
    holds: "Claim holds up against seller prices at fetch time.",
    unverified: findings.find((f) => f.id === "price")?.status === "unverified"
      ? "Not confirmed: no seller was seen at the claimed price."
      : "Partly verified: the price checks out, but the MRP / “was” price could not be confirmed.",
    overstated: "Discount overstated: the deal is real but smaller than claimed.",
    fails: "Claim does not hold against seller prices at fetch time.",
    insufficient: "Not enough data to judge.",
  }[worst];
  return { claim, basis, comparable, excluded, stats: st, findings, verdict: { status: worst, headline } };
}
