// Every recorded example must work from its own pasted text (parse -> check) with no network, and its
// verdict must stay what the README and the demo video say. Uses the REAL recorded SerpApi responses.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

process.env.PCC_MODE = "recorded";
process.env.PCC_DATA_DIR = "/nonexistent-pcc-test";
vi.stubGlobal("fetch", () => { throw new Error("network disabled in tests"); });
const { parseClaim } = await import("../src/claim.js");
const { runCheck } = await import("../src/pipeline.js");
const examples = JSON.parse(readFileSync(new URL("../fixtures/recorded/examples.json", import.meta.url), "utf8"));
const expected = ["fails", "overstated", "holds", "insufficient", "holds", "insufficient"]; // cooktop, steam iron, cooker set, air fryer, dry iron, earbuds

describe("recorded examples", () => {
  examples.forEach((ex: any, i: number) => {
    it(`${ex.label}: pasted text parses to the stored claim and replays to "${expected[i]}"`, async () => {
      const parsed = parseClaim(ex.text);
      expect(parsed).toEqual(ex.claim);
      const r = await runCheck(parsed, { mode: "recorded" });
      expect(r.creditsSpent).toBe(0);
      expect(r.sources.every((s) => s.source === "RECORDED")).toBe(true);
      expect(r.report.verdict.status).toBe(expected[i]);
    });
  });
  it("word order and unit spelling do not matter for replay", async () => {
    const r = await runCheck({ product: "induction cooktop 2000 W Prestige PIC 16.0 plus", price: 3299, discountPct: null, referencePrice: null, claimsLowest: true }, { mode: "recorded" });
    expect(r.report.stats?.n).toBe(11);
  });
  it("store rows naming a different or no model are left out, with the reason", async () => {
    const r = await runCheck(examples[0].claim, { mode: "recorded" });
    const reasons = r.report.excluded.map((e: any) => `${e.offer.seller}: ${e.reason}`).join("\n");
    expect(reasons).toMatch(/Moglix: store title does not name model "16.0"/);
    expect(reasons).toMatch(/Digihaat: store title does not name model "16.0"/);
    expect(r.report.comparable.some((o: any) => /PIC2\.0/.test(o.title))).toBe(false);
    const c = await runCheck(examples[2].claim, { mode: "recorded" });
    expect(c.report.comparable.some((o: any) => /Curve/.test(o.title))).toBe(false);
  });
});
