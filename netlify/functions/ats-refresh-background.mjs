import { getStore } from "@netlify/blobs";
import { crawlCompanies, loadCompanyList, countTokens } from "./_ats.mjs";

// Crawl all ATS company boards (Greenhouse/Lever/Ashby) and cache the merged
// result in Blobs so /api/discover can serve it instantly. A full crawl of the
// company list takes ~10s, past the 10s sync-function limit, so this is a
// Netlify *background* function (the "-background" suffix → 15-min budget,
// returns 202 immediately). The webapp pings it on each Discover open; it's
// TTL-gated so a crawl only actually runs when the cache is stale.
const REFRESH_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

export default async (req) => {
  const store = getStore("discover");
  const force = new URL(req.url).searchParams.get("force") === "1";

  let cached = null;
  try { cached = await store.get("ats-latest", { type: "json" }); } catch (_) { cached = null; }
  if (!force && cached && cached.ts && Date.now() - cached.ts < REFRESH_TTL_MS) {
    return; // fresh enough — nothing to do
  }

  const companies = await loadCompanyList();
  const jobs = await crawlCompanies(companies, { concurrency: 16 });
  // Only persist a non-empty crawl, so a transient network blip can't wipe the
  // cache and leave Discover without ATS roles.
  if (jobs.length) {
    try {
      await store.setJSON("ats-latest", { ts: Date.now(), jobs, companies: countTokens(companies) });
    } catch (_) { /* non-fatal */ }
  }
};
