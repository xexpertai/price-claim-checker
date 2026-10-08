import { describe, expect, it } from "vitest";
import { parseClaim } from "../src/claim.js";

describe("parseClaim", () => {
  it("reads price, % off, MRP and a lowest-price claim", () => {
    const c = parseClaim("5 litre stainless steel pressure cooker at ₹1,499 – 50% off, MRP ₹2,999, lowest price ever!");
    expect(c).toMatchObject({ price: 1499, discountPct: 50, referencePrice: 2999, claimsLowest: true });
    expect(c.product).toBe("5 litre stainless steel pressure cooker");
  });
  it("handles Rs., lakh-style commas and a 'was' price before the price", () => {
    const c = parseClaim("Was Rs. 1,24,999 now Rs 89,990 for the 55 inch 4K TV");
    expect(c.referencePrice).toBe(124999);
    expect(c.price).toBe(89990);
    expect(c.discountPct).toBeNull();
    expect(c.product).toContain("55 inch 4K TV");
  });
  it("reads 'k' amounts and 'flat N% discount'", () => {
    const c = parseClaim("Wireless earbuds just ₹1.5k, flat 40% discount");
    expect(c.price).toBe(1500);
    expect(c.discountPct).toBe(40);
  });
  it("does not treat a plain percentage as a discount", () => {
    const c = parseClaim("100% cotton bedsheet double ₹699");
    expect(c.discountPct).toBeNull();
    expect(c.price).toBe(699);
    expect(c.product).toContain("cotton bedsheet double");
  });
  it("cheapest / all-time low count as lowest-price claims", () => {
    expect(parseClaim("cheapest ever ₹99 mug").claimsLowest).toBe(true);
    expect(parseClaim("All-time low: ₹99 mug").claimsLowest).toBe(true);
    expect(parseClaim("₹99 mug").claimsLowest).toBe(false);
  });
  it("leaves fields empty when absent", () => {
    expect(parseClaim("basmati rice 5 kg")).toEqual({ product: "basmati rice 5 kg", price: null, discountPct: null, referencePrice: null, claimsLowest: false });
  });

  it("does not read 'rs' inside words as rupees (speakers, sneakers)", () => {
    const a = parseClaim("Portable speakers 2 pack at ₹1,499, 50% off");
    expect(a.price).toBe(1499);
    expect(a.product).toBe("Portable speakers 2 pack");
    const b = parseClaim("Running sneakers 10 now ₹4,199");
    expect(b.price).toBe(4199);
    expect(b.product).toBe("Running sneakers 10");
  });
  it("reads Rs, Rs. and INR amounts", () => {
    expect(parseClaim("Mixer grinder Rs 999").price).toBe(999);
    expect(parseClaim("Mixer grinder Rs.999").price).toBe(999);
    expect(parseClaim("Mixer grinder INR 1,299").price).toBe(1299);
    const r = parseClaim("Mixer grinder deal price 2,499 rupees");
    expect(r.price).toBe(2499);
    expect(r.product).toBe("Mixer grinder");
    expect(parseClaim("Mixer grinder 999 Rs").price).toBe(999);
  });
  it("keeps model numbers and strips deal filler and stray punctuation", () => {
    const c = parseClaim("1200 watt steam iron, only ₹999 – 20% off, lowest price anywhere!");
    expect(c.product).toBe("1200 watt steam iron");
    const d = parseClaim("Philips GC1011/01 steam iron at ₹999 — 20% off today!");
    expect(d.product).toBe("Philips GC1011/01 steam iron");
  });
  it("finds the discount after a non-discount percentage", () => {
    expect(parseClaim("100% cotton bedsheet ₹699, 40% off").discountPct).toBe(40);
  });
  it("reads an MRP written without the rupee sign, and keeps its digits out of the query", () => {
    const a = parseClaim("Wireless earbuds 141 at ₹1,299, MRP 3,990");
    expect(a).toMatchObject({ price: 1299, referencePrice: 3990, product: "Wireless earbuds 141" });
    const b = parseClaim("Galaxy phone 128GB ₹14,999 (MRP 28999) 48% off");
    expect(b).toMatchObject({ price: 14999, referencePrice: 28999, discountPct: 48, product: "Galaxy phone 128GB" });
    expect(parseClaim("Mixer grinder 750W ₹2,499 M.R.P. 4500")).toMatchObject({ price: 2499, referencePrice: 4500, product: "Mixer grinder 750W" });
  });
});
