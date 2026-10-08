// Deterministic parser for a pasted deal claim. No LLM: a handful of regexes for the shapes deal
// posts in India actually use ("₹1,299 (60% off)", "MRP ₹3,999", "was Rs. 2,499", "lowest price ever").
// Whatever it extracts is shown back to the user as editable fields before anything is checked.

export interface Claim {
  product: string;          // search query for the product
  price: number | null;     // claimed selling price in INR
  discountPct: number | null; // claimed discount, e.g. 60 for "60% off"
  referencePrice: number | null; // claimed MRP / "was" / strike-through price in INR
  claimsLowest: boolean;    // "lowest price", "cheapest", "best price"...
}

// Word-bounded so "speakers 2" or "sneakers 10" are not read as "Rs 2" / "Rs 10".
const RUPEE = String.raw`(?:₹|\brs\.?(?![a-z])|\binr(?![a-z])|\brupees?(?![a-z]))\s*`;
const AMOUNT = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(\s*k\b)?`;

export function parseAmount(raw: string, kSuffix?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  return kSuffix && kSuffix.trim() ? n * 1000 : n;
}

export function parseClaim(text: string): Claim {
  const t = text.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();

  // Reference price: "MRP ₹3,999", "M.R.P: Rs 3999", "was ₹2,499", "originally ₹…", "list price ₹…"
  let referencePrice: number | null = null;
  // The rupee sign is optional after an MRP word ("MRP 3,990", "(MRP 28999)").
  const refRe = new RegExp(String.raw`\b(?:m\.?r\.?p\.?|was|originally|list price|regular price|strike(?:d)?(?: price)?)\s*[:\-]?\s*(?:of\s*)?(?:${RUPEE})?${AMOUNT}`, "i");
  const ref = refRe.exec(t);
  if (ref) referencePrice = parseAmount(ref[1], ref[2]);

  // All rupee amounts in order; the selling price is the first one that is not the reference price.
  const amounts: { value: number; index: number }[] = [];
  const amtRe = new RegExp(`${RUPEE}${AMOUNT}`, "gi");
  for (let m; (m = amtRe.exec(t)); ) amounts.push({ value: parseAmount(m[1], m[2]), index: m.index });
  const refIndex = ref ? ref.index : -1;
  const refEnd = ref ? ref.index + ref[0].length : -1;
  // Suffix form: "2,499 rupees", "999 Rs", "1,299 INR".
  const sufRe = new RegExp(String.raw`${AMOUNT}\s*(?:rupees?|rs\.?|inr)(?![a-z])`, "gi");
  for (let m; (m = sufRe.exec(t)); ) amounts.push({ value: parseAmount(m[1], m[2]), index: m.index });
  amounts.sort((a, b) => a.index - b.index);
  const sell = amounts.find((a) => !(a.index >= refIndex && a.index < refEnd));
  const price = sell ? sell.value : null;

  // Discount: "60% off", "flat 40 % discount", "save 25%", "-35%"
  // Only a percentage that is said to be a discount counts ("100% cotton" does not).
  let discountPct: number | null = null;
  for (const m of t.matchAll(/(save|flat|upto|up to|-)?\s*\b(\d{1,2}(?:\.\d)?)\s*%\s*(off|discount|cheaper|less)?/gi)) {
    if (m[1] || m[3]) { discountPct = Number(m[2]); break; }
  }

  const claimsLowest = /\b(lowest|cheapest|best price|all[- ]time low|never been cheaper|lowest ever|rock[- ]bottom)\b/i.test(lower);

  // Product: the text with prices, percentages and deal words removed.
  let product = t
    .replace(refRe, " ")
    .replace(new RegExp(`${RUPEE}${AMOUNT}`, "gi"), " ")
    .replace(new RegExp(String.raw`${AMOUNT}\s*(?:rupees?|rs\.?|inr)(?![a-z])`, "gi"), " ")
    .replace(/(?:save|flat|upto|up to)?\s*\b\d{1,2}(?:\.\d)?\s*%\s*(?:off|discount|cheaper|less)/gi, " ")
    .replace(/\b(all[- ]time low|never been cheaper|lowest ever|rock[- ]bottom|limited time|deal of the day|free delivery|in stock|lowest|cheapest|best|price|prices|deal|deals|offer|sale|only|just|now|at|for|is|it's|its|get|grab|hurry|loot|today|tonight|ever|anywhere|everywhere|online|off|discount|with|on|the|a|an|mrp|m\.r\.p\.?)\b/gi, " ")
    .replace(/[!?*()[\]{}|:;"“”'’@#,]+/g, " ")
    .replace(/\s[-–—.]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[-–,.]+$/, "")
    .trim();
  if (!product) product = t;

  return { product, price, discountPct, referencePrice, claimsLowest };
}
