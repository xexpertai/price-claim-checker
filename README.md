# Price-Claim Checker

**Is that deal really a deal?** Paste an Indian online deal claim, such as *"₹1,499, 50% off, MRP ₹2,999, lowest price ever!"*. The app pulls Google Shopping India data through [SerpApi](https://serpapi.com), finds the same product at other sellers, and checks each part of the claim with fixed, published rules. Every number in the verdict links back to the seller listing and to the SerpApi search it came from, along with the fetch time.

- **Track:** Commerce & Market Intelligence (SerpApi India Hackathon 2026)
- **No AI at runtime.** The verdict is deterministic: the same data always gives the same answer, and each rule is listed below. A check uses at most 2 SerpApi searches; repeat checks are served from cache.
- **Honest labels.** Each result is marked **LIVE** (fetched just now), **CACHED** (fetched earlier on this machine) or **RECORDED** (a real SerpApi response saved earlier and replayed).

## Why

Festive-sale posts and forwards in India often state a big "% off" against an MRP that no seller actually charges, or call a price "the lowest" when another store is cheaper. A shopper can't easily check this from one product page. What actually matters is **what the same product costs at other sellers right now**. Google Shopping already gathers that data, and SerpApi makes it available as structured JSON.

## Why deterministic, not an LLM

This is a consumer-protection tool, so its verdict has to be auditable. The same data always gives the same answer, each rule is a few lines in `src/check.ts` with its thresholds in one `RULES` object, and every number traces back to a SerpApi search id. A language model would add cost per check and could paraphrase or invent numbers. Here the intelligence is in how the SerpApi data is chained and filtered: the matched product, its stores, and the excluded listings with reasons.

## What it checks

| Check | Rule (see `src/check.ts`, `RULES`) | Possible results |
|---|---|---|
| Claimed price vs the market | Where the claimed price sits among sellers (min / median / max). If it is more than 3% below every seller, it is flagged: a coupon may be needed, or the deal may have ended. | Context / Not confirmed |
| "Lowest price" | Holds if no seller is cheaper than the claimed price by more than 1%. Otherwise the result names the cheaper seller and the rupee gap. | Holds / Does not hold |
| "X% off" | The **real saving vs the median seller price** must be within 5 points of the claimed %. A real but smaller saving (≥ 5%) counts as *overstated*. A saving under 5%, or none, fails. | Holds / Overstated / Does not hold |
| MRP / "was" price | This is corroborated when any seller lists the same original price (within 3%), or when at least two sellers actually charge it or more (within 5%); one expensive outlier seller is not enough. Otherwise it is *flagged, not failed*, because an MRP can be legitimate even when nobody charges it. If only "% off" is given, the implied MRP is computed. | Holds / Not confirmed |
| Enough data? | At least 2 comparable sellers are needed; otherwise the result is "Not enough data". | Not enough data |

The overall verdict is the worst individual result. Listings that are left out are shown along with the reason:
- a missing model or size token;
- a title that matches under 60% of the product words;
- a price under 35% or over 3× the median (likely an accessory or a bundle).

## How SerpApi is used

| Step | Engine | Parameters | Why |
|---|---|---|---|
| 1 | `google_shopping` | `q`, `gl=in`, `hl=en`, `google_domain=google.co.in` | Gets candidate products and listings in INR for India |
| 2 | `google_immersive_product` | `page_token` (from step 1, for the best-matching product), `more_stores=true` | Gets **the same product at many sellers**, with each store's price, its listed original price and a link |
| (free) | Account API | none | A live "searches left" meter in the header; it uses no search credits |

Other SerpApi features used:
- **Seller hygiene:** stores that are evidently outside India (a foreign domain such as `.ae`, or a country in the store name) are excluded with the reason shown. B2B / wholesale marketplaces are excluded too. Storefront variants of one merchant ("X" and "X - Now") count once, and the dropped duplicate is listed with its reason.
- **Product matching** (`src/offers.ts`) scores step-1 titles against the query. Model and size tokens such as `1.5l` or `55` are mandatory. Each store row on the product page is also title-checked, so a sibling model or a row that names no model is left out. Accessory listings ("case cover compatible with …") never count as the product. In LIVE mode the user can pick another candidate product ("Not the right product?").
- **Receipts:** `search_metadata.id` and `processed_at` travel with every offer. `/api/raw/<search id>` shows the exact JSON that a verdict was computed from.
- **Credit discipline:**
  - a local cache (6 h by default; `CACHE_TTL_HOURS`), on top of SerpApi's own cache, where cached searches are free;
  - a local ledger with a hard cap (`CREDIT_CAP`, 150 by default) that is checked before every live call;
  - tests stub `fetch`, so they can never spend a credit.

## Setup

Requirements: Node.js 20 or newer.

```bash
git clone https://github.com/xexpertai/price-claim-checker.git
cd price-claim-checker
npm install
npm start            # http://127.0.0.1:8787
```

The app works **without a key**: it then replays the recorded examples in `fixtures/recorded/` (real SerpApi responses from 8 Oct 2026, labelled RECORDED). Each example claim names one exact model (an induction cooktop, a steam iron, a pressure cooker set, a dry iron), plus two that show "Not enough data": a deliberately generic air-fryer claim, and an earbuds claim whose search returned only cases and covers, which the app refuses to treat as the product. You can click an example or paste its text: replay matches the search words in any order. In replay mode, any other claim gets a clear "not recorded" message.

For live checks, add a free SerpApi key ([serpapi.com](https://serpapi.com/users/sign_up)):

```bash
# .env.local is git-ignored
read -s -p "SerpApi key: " K && printf 'SERPAPI_API_KEY=%s\n' "$K" > .env.local && unset K
npm start
```

Optional settings in `.env.local`:
- `CREDIT_CAP=150`: the most live searches this install will make;
- `CACHE_TTL_HOURS=6`;
- `PORT=8787`;
- `PCC_MODE=recorded`: replay only, even when a key is set.

Other commands:

```bash
npm test             # vitest: parser, checker rules, offer parsing, pipeline replay, credit cap
npm run typecheck
npm run credits      # local ledger + searches left on your SerpApi plan (free call)
npm run record -- "product query"   # save real responses to fixtures/recorded/ (2 credits)
```

### Hosting (optional)

`scripts/deploy-cloudrun.sh` deploys the app to Google Cloud Run in **RECORDED mode**:
- the `Dockerfile` copies only `src/`, `public/` and `fixtures/recorded/`;
- the service has no API key and no secrets, so a public visitor cannot spend SerpApi credits;
- `plan` shows what it will create, `CONFIRM_PUBLIC=1 … deploy` deploys, and `verify` runs a smoke test.

### JSON API

The UI is a thin client over a small API, so the checker can be used from scripts or bots:

```bash
curl -s localhost:8787/api/parse -d '{"text":"5 litre pressure cooker at ₹1,499, 50% off, lowest price!"}'
curl -s localhost:8787/api/check -d '{"claim":{"product":"5 litre pressure cooker","price":1499,"discountPct":50,"claimsLowest":true}}'
```

`/api/check` returns the verdict, each finding with its numbers, the comparable and excluded offers, and the SerpApi search ids. A link like `/?claim=<url-encoded text>` opens the app with the claim already filled in.

## Architecture

```
public/            index.html, app.js, styles.css: plain JS UI, no build step, mobile-friendly
src/server.ts      node:http server: /api/parse, /api/check, /api/status, /api/raw/:searchId, static files
src/claim.ts       deterministic claim parser (₹ / Rs / INR, lakh commas, "1.5k", % off, MRP / was, "lowest")
src/pipeline.ts    google_shopping -> pick product -> google_immersive_product -> checker
src/offers.ts      SerpApi JSON -> offers with receipts; title relevance; product picking
src/check.ts       the rules: comparable-set selection, stats, findings, verdict
src/serpapi.ts     SerpApi client: LIVE / CACHED / RECORDED, ledger + cap, key redaction, Account API
fixtures/recorded  real SerpApi responses used for replay and the demo
fixtures/synthetic invented, SerpApi-shaped test data (labelled; only used in tests)
tests/             vitest
```

## Demo video

The demo is produced by `scripts/video/make.sh`, which records the real app with Playwright and uses no screen mock-ups:
- the app runs in **RECORDED** mode, replaying the real SerpApi responses in `fixtures/recorded/`;
- the narration is Kokoro TTS and the captions come from faster-whisper, both run locally;
- the build aborts if synthetic test data ever appears on screen.

The video uses `?anon=1`, which replaces store and product names with "Store A, B…" and shows a banner saying so. Prices, counts and search ids are unchanged. The example claims are written for the demo and labelled as such in the app.

## Limitations

- **A snapshot, not a price history.** The app compares a claim with what sellers charge at fetch time. A price that was higher last week is not visible to it.
- **What Google Shopping shows is what it sees.** Coupons, bank offers, card EMI discounts, membership prices and stock are not included. Some sellers are not listed at all.
- **Product matching is heuristic.** Variants (colour, storage, pack size) can be grouped together or split apart. The picked product and every excluded listing are shown so the user can correct it.
- The claim parser is rule-based English. Unusual phrasings may need the fields to be corrected by hand. The form is always shown before checking.
- MRP is a legal maximum price in India and can be legitimate even when nobody charges it, so an MRP that can't be corroborated is flagged, not failed.

## AI assistance disclosure

This project was **built with AI assistance (Claude, by Anthropic)**, which helped with code, tests and documentation. The app itself uses **no AI model at runtime**: claim parsing and verdicts are deterministic code.

## Data and trademarks

Data comes from Google Shopping via SerpApi. The project is not affiliated with SerpApi or Google. Store and product names shown in the app come from the fetched listings.

## License

[MIT](LICENSE) © 2026 Harsha Shinde
