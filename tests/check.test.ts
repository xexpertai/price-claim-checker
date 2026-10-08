// Unit tests for the deterministic checker. All prices here are SYNTHETIC test values.
import { describe, expect, it } from "vitest";
import { checkClaim, claimedDiscount, claimedReference, dedupeBySeller, median, selectComparable } from "../src/check.js";
import type { Claim } from "../src/claim.js";
import type { Offer } from "../src/offers.js";

const receipt = { engine: "google_immersive_product", searchId: "synthetic", fetchedAt: "2026-10-08 06:00:00 UTC" };
const o = (seller: string, price: number, originalPrice: number | null = null, title = "Test Kettle 1.5L Steel"): Offer => ({ seller, title, price, originalPrice, link: `https://example.com/${seller}`, receipt });
const claim = (c: Partial<Claim>): Claim => ({ product: "test kettle 1.5l", price: null, discountPct: null, referencePrice: null, claimsLowest: false, ...c });
const market = [o("A", 1000), o("B", 1050), o("C", 1100), o("D", 1200, 1500)]; // median 1075
const find = (r: ReturnType<typeof checkClaim>, id: string) => r.findings.find((f) => f.id === id)!;

describe("median", () => {
  it("odd and even", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("lowest-price claims", () => {
  it("holds when no seller is cheaper", () => {
    const r = checkClaim(claim({ price: 999, claimsLowest: true }), market);
    expect(find(r, "lowest").status).toBe("holds");
    expect(find(r, "lowest").numbers.map((n) => n.label)).toEqual(["cheapest seen"]); // no negative "difference"
    expect(r.verdict.status).toBe("holds");
  });
  it("tolerates 1% above the cheapest seller", () => {
    expect(find(checkClaim(claim({ price: 1010, claimsLowest: true }), market), "lowest").status).toBe("holds");
    expect(find(checkClaim(claim({ price: 1011, claimsLowest: true }), market), "lowest").status).toBe("fails");
  });
  it("fails and names the cheaper seller and the gap", () => {
    const r = checkClaim(claim({ price: 1100, claimsLowest: true }), market);
    const f = find(r, "lowest");
    expect(f.status).toBe("fails");
    expect(f.detail).toContain("A sells it for ₹1,000, ₹100 less");
    expect(f.numbers[0].offer?.seller).toBe("A");
    expect(r.verdict.status).toBe("fails");
  });
});

describe("discount claims are measured against the median seller price", () => {
  it("holds when the real saving is within 5 points of the claim", () => {
    // 1075 median, price 860 => 20% real saving; claim 25% => within slack
    expect(find(checkClaim(claim({ price: 860, discountPct: 25 }), market), "discount").status).toBe("holds");
  });
  it("overstated when real saving is positive but far below the claim", () => {
    // price 950 => 11.6% real; claim 50%
    const f = find(checkClaim(claim({ price: 950, discountPct: 50 }), market), "discount");
    expect(f.status).toBe("overstated");
    expect(f.detail).toContain("11.6%");
  });
  it("fails when the price is at or above the market median", () => {
    const f = find(checkClaim(claim({ price: 1100, discountPct: 60 }), market), "discount");
    expect(f.status).toBe("fails");
    expect(f.detail).toContain("above the median");
  });
  it("derives the claimed discount from price and MRP", () => {
    expect(claimedDiscount(claim({ price: 500, referencePrice: 1000 }))).toBe(50);
    expect(claimedDiscount(claim({ price: 500 }))).toBeNull();
  });
});

describe("reference (MRP / was) price", () => {
  it("is corroborated by a seller's listed original price within 3%", () => {
    const f = find(checkClaim(claim({ price: 999, referencePrice: 1490 }), market), "reference");
    expect(f.status).toBe("holds");
    expect(f.detail).toContain("D also lists ₹1,500");
  });
  it("is corroborated when a seller actually charges about that much", () => {
    expect(find(checkClaim(claim({ price: 999, referencePrice: 1100 }), market), "reference").status).toBe("holds");
  });
  it("one expensive seller alone does not corroborate it", () => {
    const f = find(checkClaim(claim({ price: 999, referencePrice: 1250 }), market), "reference");
    expect(f.status).toBe("unverified");
    expect(f.detail).toContain("Only one seller (D, ₹1,200)");
  });
  it("is flagged (not failed) when nobody lists or charges it", () => {
    const r = checkClaim(claim({ price: 999, referencePrice: 3999 }), market);
    expect(find(r, "reference").status).toBe("unverified");
    expect(find(r, "reference").detail).toContain("highest listed original price: ₹1,500 (D)");
  });
  it("implied MRP from price and % off", () => {
    expect(claimedReference(claim({ price: 600, discountPct: 40 }))).toEqual({ value: 1000, implied: true });
    expect(claimedReference(claim({ price: 600, referencePrice: 900 }))).toEqual({ value: 900, implied: false });
  });
});

describe("verdict", () => {
  it("is insufficient with fewer than two sellers", () => {
    const r = checkClaim(claim({ price: 999, claimsLowest: true }), [o("A", 1000)]);
    expect(r.verdict.status).toBe("insufficient");
    expect(r.findings).toHaveLength(0);
  });
  it("is insufficient without a claimed price", () => {
    expect(checkClaim(claim({ discountPct: 40 }), market).verdict.status).toBe("insufficient");
  });
  it("takes the worst finding", () => {
    // lowest holds, discount overstated, MRP unverified -> overstated
    const r = checkClaim(claim({ price: 990, discountPct: 50, claimsLowest: true }), market);
    expect(r.findings.map((f) => f.status)).toEqual(["info", "holds", "overstated", "unverified"]);
    expect(r.verdict.status).toBe("overstated");
  });
  it("flags a price below every seller as not confirmed", () => {
    expect(find(checkClaim(claim({ price: 700 }), market), "price").status).toBe("unverified");
  });
  it("only a price: context, not a verdict", () => {
    expect(checkClaim(claim({ price: 1050 }), market).verdict.status).toBe("info");
  });
  it("is deterministic", () => {
    const c = claim({ price: 990, discountPct: 50, claimsLowest: true });
    expect(checkClaim(c, market)).toEqual(checkClaim(c, [...market].reverse()));
  });
});

describe("selecting comparable offers", () => {
  it("dedupes a seller to its cheapest offer", () => {
    expect(dedupeBySeller([o("A", 10), o("a ", 8), o("B", 9)]).map((x) => [x.seller, x.price])).toEqual([["a ", 8], ["B", 9]]);
  });
  it("prefers same-product store offers when at least two exist", () => {
    const s = selectComparable("test kettle 1.5l", [o("A", 1000), o("B", 1100)], [o("Z", 1, null, "unrelated")]);
    expect(s.basis).toBe("same product, several sellers");
    expect(s.comparable).toHaveLength(2);
  });
  it("falls back to similar listings, excluding wrong models and low-relevance titles", () => {
    const shop = { ...receipt, engine: "google_shopping" };
    const listings = [o("A", 1000), o("B", 1100, null, "Test Kettle 1.8L Steel"), o("C", 1050, null, "Steel bottle 1.5L"), o("D", 1080)].map((x) => ({ ...x, receipt: shop }));
    const s = selectComparable("test kettle 1.5l", [], listings);
    expect(s.basis).toBe("similar listings");
    expect(s.comparable.map((x) => x.seller)).toEqual(["A", "D"]);
    expect(s.excluded.map((e) => e.reason)).toEqual([expect.stringContaining('lacks model/size "1.5l"'), expect.stringContaining("matches only")]);
  });
  it("drops price outliers (accessories, bundles)", () => {
    const s = selectComparable("x", [o("A", 1000), o("B", 1100), o("C", 1050), o("D", 200), o("E", 5000)], []);
    expect(s.comparable.map((x) => x.seller)).toEqual(["A", "C", "B"]);
    expect(s.excluded).toHaveLength(2);
  });
});

describe("seller hygiene", async () => {
  const { foreignSeller, sellerKey } = await import("../src/check.js");
  it("merges storefront variants of one merchant", () => {
    expect(sellerKey("Myntra - MNow")).toBe(sellerKey("Myntra"));
    expect(dedupeBySeller([o("Myntra", 3549), o("Myntra - MNow", 3549)])).toHaveLength(1);
  });
  it("excludes sellers outside India", () => {
    expect(foreignSeller(o("Desertcart.ae", 3346))).toContain(".ae");
    expect(foreignSeller({ ...o("Shop", 10), link: "https://shop.example.co.uk/item" })).toContain(".uk");
    expect(foreignSeller(o("Fetch N Buy | United Kingdom", 10))).toBeTruthy();
    expect(foreignSeller(o("Amazon.in", 10))).toBeNull();
    const s = selectComparable("x", [o("A", 1000), o("B", 1100), o("Desertcart.ae", 1050)], []);
    expect(s.comparable.map((x) => x.seller)).toEqual(["A", "B"]);
    expect(s.excluded[0].reason).toContain("outside India");
  });
});

describe("store title check", async () => {
  const { storeMismatch } = await import("../src/offers.js");
  it("flags a sibling model, a missing model and a different size; accepts spelling variants", () => {
    expect(storeMismatch("Prestige PIC 16.0 plus 2000W induction cooktop", "Prestige 2000W Induction Cooktop, PIC2.0-V2 R")).toContain('does not name model "16.0"');
    expect(storeMismatch("Prestige PIC 16.0 plus 2000W induction cooktop", "Prestige 2000 watt induction cooktop")).toContain("does not name model");
    expect(storeMismatch("Butterfly Cordial 2L 3L 5L pressure cooker combo", "Butterfly Curve 2, 3 & 5.5 Litre Stainless Steel Outer Lid Pressure Cooker Combo")).toBeTruthy();
    expect(storeMismatch("Philips GC1011/01 steam iron", "Philips GC 1011 Blue Plastic Steam Iron-1200W")).toBeNull();
    expect(storeMismatch("Prestige PIC 16.0 plus 2000W induction cooktop", "INDUCTION COOKER PRESTIGE COOK TOP PIC 16.0 PLUS")).toBeNull();
    expect(storeMismatch("Philips GC1011/01 steam iron", "")).toBeNull();
  });
});

describe("R3 fixes", async () => {
  const { normaliseUnits, relevance } = await import("../src/offers.js");
  it("a unit shared by a list of sizes applies to each size", () => {
    expect(normaliseUnits("Cordial 2, 3 & 5 Litres")).toContain("2l 3l 5l");
    expect(normaliseUnits("2/3/5 L cooker")).toContain("2l 3l 5l");
    expect(relevance("Butterfly Cordial 2L 3L 5L pressure cooker combo", "Butterfly Cordial 2, 3 & 5 Litres Outer Lid SS Pressure Cookers").missingModel).toEqual([]);
  });
  it("merchant duplicates are listed as left out, not dropped silently", () => {
    const ex: any[] = [];
    const kept = dedupeBySeller([o("Myntra", 3549), o("Myntra - MNow", 3600)], ex);
    expect(kept.map((x) => x.seller)).toEqual(["Myntra"]);
    expect(ex[0].reason).toContain("same merchant as Myntra");
  });
  it("a failed % off reads 'No real saving' (the MRP arithmetic may be right)", () => {
    const f = find(checkClaim(claim({ price: 1100, discountPct: 60 }), market), "discount");
    expect(f.status).toBe("fails");
    expect(f.label).toBe("No real saving");
  });
});
