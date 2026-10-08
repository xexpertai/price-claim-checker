// Prints this project's SerpApi usage: the local ledger, and the plan's remaining searches (Account API, free).
import { account, CREDIT_CAP, readLedger } from "../src/serpapi.js";
const l = readLedger();
console.log(`local ledger: ${l.credits}/${CREDIT_CAP} searches`);
const a = await account();
console.log(a ? `SerpApi account: ${a.this_month_usage ?? "?"} used this month, ${a.plan_searches_left ?? "?"} left on plan (${a.searches_per_month ?? "?"}/month)` : "SerpApi account: no key or unavailable");
