// Price-Claim Checker UI. Plain JS, no build step.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ANON = params.get("anon") === "1";
let status = null;
let lastClaim = null;

const inr = (x) => "₹" + Math.round(x).toLocaleString("en-IN");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ist = (iso) => {
  const d = new Date(String(iso).replace(" UTC", "Z").replace(" ", "T"));
  return isNaN(d) ? esc(iso) : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " IST";
};
const LABEL = { info: "Context", holds: "Holds", unverified: "Not confirmed", overstated: "Overstated", fails: "Does not hold", insufficient: "Not enough data" };

// Recording mode: stable pseudonyms so the demo video carries no store or brand names.
const aliases = new Map();
const seller = (name) => {
  if (!ANON) return name;
  if (!aliases.has(name)) { const n = aliases.size; aliases.set(name, "Store " + (n >= 26 ? String.fromCharCode(65 + Math.floor(n / 26) - 1) : "") + String.fromCharCode(65 + (n % 26))); }
  return aliases.get(name);
};
const title = (t) => (ANON ? "(product name hidden)" : t);
const anonText = (s) => { if (!ANON) return s; for (const [n, a] of aliases) s = s.split(n).join(a); return s; };

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { notRecorded: Boolean(j.notRecorded) });
  return j;
}

function renderStatus() {
  const live = status.mode === "live";
  $("modeBadge").textContent = live ? "LIVE" : "RECORDED";
  $("modeBadge").className = "badge " + (live ? "LIVE" : "RECORDED");
  $("modeBadge").title = live ? "Checks fetch fresh Google Shopping data through SerpApi (cached up to a few hours)." : "Replaying real SerpApi responses recorded earlier; no live searches.";
  const acct = status.account?.plan_searches_left != null ? ` · ${status.account.plan_searches_left} left on SerpApi plan` : "";
  $("credits").textContent = live ? `${status.ledger.credits}/${status.ledger.cap} searches used${acct}` : "0 searches spent (replay)";
  $("costHint").textContent = live ? "Uses up to 2 SerpApi searches (0 if cached)." : "Replays recorded searches: only the recorded examples above can be checked.";
  if (status.examples?.length) {
    $("examples").hidden = false;
    $("exList").innerHTML = status.examples.map((e, i) => `<button class="chip" data-i="${i}" type="button">${esc(e.label ?? e.text)}</button>`).join("");
  }
}

function fillForm(c) {
  $("fProduct").value = c.product ?? "";
  $("fPrice").value = c.price ?? "";
  $("fDisc").value = c.discountPct ?? "";
  $("fRef").value = c.referencePrice ?? "";
  $("fLowest").checked = Boolean(c.claimsLowest);
}
let anonProduct = null;
const readForm = () => ({ product: anonProduct && $("fProduct").value === anonProduct.shown ? anonProduct.real : $("fProduct").value, price: $("fPrice").value, discountPct: $("fDisc").value, referencePrice: $("fRef").value, claimsLowest: $("fLowest").checked });

function chart(r) {
  const offers = r.report.comparable;
  const P = r.report.claim.price;
  if (!offers.length) return "";
  const vals = offers.map((o) => o.price).concat(P != null ? [P] : []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || hi * 0.05;
  lo -= pad; hi += pad;
  const W = innerWidth < 600 ? 420 : 900, H = 120, L = 20, R = 20;
  const x = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const med = r.report.stats.median;
  const dots = offers.map((o, i) => `<circle class="dot" cx="${x(o.price).toFixed(1)}" cy="${62 + ((i % 3) - 1) * 10}" r="6"><title>${esc(seller(o.seller))}: ${inr(o.price)}</title></circle>`).join("");
  const claim = P != null ? `<line class="claim" x1="${x(P)}" x2="${x(P)}" y1="28" y2="92"/><text class="claim-t" x="${x(P)}" y="20" text-anchor="middle">claimed ${inr(P)}</text>` : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Seller prices with the claimed price and median marked">
    <line class="axis" x1="${L}" x2="${W - R}" y1="62" y2="62"/>
    <line class="med" x1="${x(med)}" x2="${x(med)}" y1="40" y2="84"/><text class="med-t" x="${x(med)}" y="108" text-anchor="middle">median ${inr(med)}</text>
    ${dots}${claim}
    ${x(med) - L > 110 ? `<text x="${L}" y="108">${inr(r.report.stats.min)}</text>` : ""}${W - R - x(med) > 110 ? `<text x="${W - R}" y="108" text-anchor="end">${inr(r.report.stats.max)}</text>` : ""}
  </svg>`;
}

function numChip(n) {
  const v = n.unit === "pct" ? `${n.value}%` : inr(n.value);
  const inner = `${esc(n.label)} <b>${v}</b>`;
  if (n.offer?.link) return `<a class="num" href="${esc(n.offer.link)}" target="_blank" rel="noopener" title="${esc(seller(n.offer.seller))} · SerpApi search ${esc(n.offer.receipt.searchId)} · ${esc(ist(n.offer.receipt.fetchedAt))}">${inner} · ${esc(seller(n.offer.seller))} ↗</a>`;
  return `<span class="num">${inner}</span>`;
}

function render(r) {
  const rep = r.report;
  aliases.clear(); // pseudonyms restart per result: Store A is always the cheapest
  rep.comparable.forEach((o) => seller(o.seller));
  const s = rep.verdict.status;
  const src = r.sources.map((x) => x.source);
  const srcLabel = src.includes("LIVE") ? "LIVE" : src.includes("CACHED") ? "CACHED" : "RECORDED";
  const when = r.sources[0] ? ist(r.sources[0].fetchedAt) : "";
  let h = r.synthetic ? `<div class="err"><b>SYNTHETIC TEST DATA.</b> These stores and prices are invented test fixtures, not real market data.</div><br>` : "";
  h += `<div class="verdict ${s}">
    <div class="v-label s-${s}">${LABEL[s]}</div>
    <div class="v-head">${esc(anonText(rep.verdict.headline))}</div>
    <div class="v-meta"><span class="src ${srcLabel}">${srcLabel}</span> Prices fetched ${when} · compared against <b>${rep.stats?.n ?? 0}</b> ${rep.basis === "similar listings" ? `similar listing${rep.stats?.n === 1 ? "" : "s"}` : rep.basis === "top match's store list" ? `store listing${rep.stats?.n === 1 ? "" : "s"} for the top-matching product` : `seller${rep.stats?.n === 1 ? "" : "s"} of the same product`}${r.product.title ? ` · ${rep.basis === "same product, several sellers" ? "product" : "top match"}: <b>${esc(title(r.product.title))}</b>` : ""}</div>
  </div>`;

  if (rep.findings.length) {
    h += `<section class="card" id="findings"><h2>What was checked</h2>`;
    for (const f of rep.findings) {
      h += `<div class="finding" data-id="${f.id}"><span class="pill s-${f.status}">${esc(f.label ?? LABEL[f.status])}</span><div>
        <div class="f-title">${esc(f.title)}</div><p class="f-detail">${esc(anonText(f.detail))}</p>
        <div class="nums">${f.numbers.map(numChip).join("")}</div></div></div>`;
    }
    h += `</section>`;
  }

  if (rep.comparable.length) {
    const enough = rep.verdict.status !== "insufficient";
    h += `<section class="card" id="sellers"><h2>Seller prices as of ${when}</h2>${enough ? chart(r) : `<p class="hint">${rep.comparable.length} listing${rep.comparable.length === 1 ? "" : "s"}, from ${rep.basis === "similar listings" ? "similar Google Shopping listings" : "the top-matching product's store list"}${rep.claim.price && rep.comparable.length === 1 && rep.comparable[0].price > rep.claim.price * 3 ? "; likely bulk/wholesale (more than 3× the claimed price)" : ""}. Too few to chart a price range or judge the claim.</p>`}
      <div class="scroll"><table><thead><tr><th>Seller</th><th class="r">Price</th><th class="r">Listed “was”</th><th>Listing</th><th class="rc">Receipt</th></tr></thead><tbody>`;
    for (const o of rep.comparable) {
      h += `<tr><td>${esc(seller(o.seller))}</td><td class="r">${inr(o.price)}</td><td class="r">${o.originalPrice ? inr(o.originalPrice) : "–"}</td>
        <td>${o.link ? `<a href="${esc(o.link)}" target="_blank" rel="noopener">open ↗</a>` : "–"}</td>
        <td class="mono rc"><a href="/api/raw/${esc(o.receipt.searchId)}" target="_blank">${esc(o.receipt.engine.replace("google_", ""))} · ${esc(o.receipt.searchId.slice(0, 10))}…</a></td></tr>`;
    }
    h += `</tbody></table></div>`;
    if (rep.excluded.length) {
      h += `<details><summary>${rep.excluded.length} listing${rep.excluded.length === 1 ? "" : "s"} left out of the comparison, and why</summary><div class="scroll"><table><tbody>`;
      for (const e of rep.excluded) h += `<tr><td>${esc(seller(e.offer.seller))}</td><td>${esc(title(e.offer.title))}</td><td class="r">${inr(e.offer.price)}</td><td>${esc(e.reason)}</td></tr>`;
      h += `</tbody></table></div></details>`;
    }
    h += `</section>`;
  }

  if (r.product.candidates.length > 1 && status.mode === "live") {
    h += `<section class="card"><details><summary>Not the right product? Pick another match${status.mode === "live" ? " (1 more search)" : ""}</summary><div class="cands">`;
    for (const c of r.product.candidates) {
      h += `<button class="chip cand" data-pick="${c.index}" type="button" ${c.index === r.product.index ? "disabled" : ""}>${esc(title(c.title))} · ${c.price ? inr(c.price) : "?"} · ${esc(seller(c.seller))}${c.multipleSources ? " · several sellers" : ""}</button>`;
    }
    h += `</div></details></section>`;
  }

  h += `<section class="card" id="receipt"><h2>Receipt</h2><p class="hint">Every number above comes from these SerpApi searches. Open a search id to see the full JSON response it was computed from.</p>
    <div class="scroll"><table><thead><tr><th>Engine</th><th>SerpApi search id</th><th>Fetched</th><th>Source</th></tr></thead><tbody>`;
  for (const x of r.sources) h += `<tr><td class="mono">${esc(x.engine)}</td><td class="mono"><a href="/api/raw/${esc(x.searchId)}" target="_blank">${esc(x.searchId)}</a></td><td>${ist(x.fetchedAt)}</td><td><span class="src ${x.source}">${x.source}</span></td></tr>`;
  h += `</tbody></table></div><p class="hint">SerpApi searches spent on this check: ${r.creditsSpent}.</p></section>`;
  $("result").innerHTML = h;
}

function notRecordedPanel(c) {
  const fields = [`product “${esc(c.product)}”`, c.price ? `price ₹${esc(c.price)}` : null, c.discountPct ? `${esc(c.discountPct)}% off` : null, c.referencePrice ? `MRP / was ₹${esc(c.referencePrice)}` : null, c.claimsLowest ? "a “lowest price” claim" : null].filter(Boolean).join(", ");
  const chips = (status.examples || []).map((e, i) => `<button class="chip" data-i="${i}" type="button">${esc(e.label ?? e.text)}</button>`).join("");
  return `<section class="card notrec"><h2>Not recorded in this demo</h2>
    <p>This instance replays real SerpApi searches recorded on 8 Oct 2026 and makes <b>no live searches</b>, so it cannot fetch prices for a new claim.</p>
    <p>With live search it would check: ${fields}. It would compare these against the same product at other Indian sellers on Google Shopping, as in the examples.</p>
    <p><b>Check it live yourself:</b> run the app locally with your own free SerpApi key (3 commands, see <a href="https://github.com/xexpertai/price-claim-checker#setup" target="_blank" rel="noopener">setup</a>). Each check uses at most 2 searches.</p>
    <p class="hint">Or try a recorded example:</p><div class="chips ex-chips">${chips}</div></section>`;
}

async function check(pick = null) {
  const btn = $("checkBtn");
  btn.disabled = true;
  $("result").innerHTML = `<p class="loading">Fetching seller prices…</p>`;
  try {
    lastClaim = readForm();
    const r = await api("/api/check", { claim: lastClaim, pick });
    render(r);
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    status = await api("/api/status"); renderStatus();
  } catch (e) {
    $("result").innerHTML = e.notRecorded ? notRecordedPanel(lastClaim) : `<div class="err">${esc(e.message)}</div>`;
  } finally { btn.disabled = false; }
}

$("parseBtn").addEventListener("click", async () => {
  const text = $("claimText").value.trim();
  if (!text) return;
  fillForm(await api("/api/parse", { text }));
  anonProduct = null;
  $("exNote").hidden = true;
  $("result").innerHTML = "";
  $("fProduct").focus();
});
$("claimText").addEventListener("input", () => { $("exNote").hidden = true; anonProduct = null; });
$("claimForm").addEventListener("submit", (e) => { e.preventDefault(); check(); });
$("exList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-i]");
  if (!b) return;
  const ex = status.examples[Number(b.dataset.i)];
  // Recording mode shows a generic description instead of the brand and model; the real claim is still checked.
  $("claimText").value = ANON && ex.anonText ? ex.anonText : ex.text;
  fillForm(ex.claim);
  anonProduct = ANON && ex.anonProduct ? { shown: ex.anonProduct, real: ex.claim.product } : null;
  if (anonProduct) $("fProduct").value = anonProduct.shown;
  $("result").innerHTML = ""; // never show a verdict next to a different claim
  if (ex.note) { $("exNote").textContent = ex.note; $("exNote").hidden = false; }
});
$("result").addEventListener("click", (e) => {
  const ex = e.target.closest(".ex-chips [data-i]");
  if (ex) { $("exList").children[Number(ex.dataset.i)].click(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  const b = e.target.closest("[data-pick]");
  if (b) { fillForm(lastClaim); if (anonProduct && lastClaim.product === anonProduct.real) $("fProduct").value = anonProduct.shown; check(Number(b.dataset.pick)); }
});

if (ANON) $("anonBanner").hidden = false;
api("/api/status").then(async (s) => {
  status = s; renderStatus();
  const pre = params.get("claim"); // shareable link: /?claim=<text>
  if (pre) { $("claimText").value = pre; fillForm(await api("/api/parse", { text: pre })); }
}).catch((e) => { $("modeBadge").textContent = "OFFLINE"; console.error(e); });
