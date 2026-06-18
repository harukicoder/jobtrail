import { getStore } from "@netlify/blobs";

// Discover feed: proxy the public Remotive remote-jobs API so the static app
// can pull live remote roles without shipping any key (Remotive needs none).
// We trim each posting to the handful of fields the UI shows and cap the
// description so a big payload can't bloat the response, then cache the result
// in Netlify Blobs for a few minutes — Remotive asks callers to be gentle, and
// the saved-search alert job (cron) hits the same endpoint.

const REMOTIVE_URL = "https://remotive.com/api/remote-jobs";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — fresh enough, polite to Remotive.
const MAX_LIMIT = 50;

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function trimJob(j) {
  return {
    id: "remotive-" + j.id,
    source: "remotive",
    // Every Remotive listing is remote — stamp it so downstream eligibility
    // heuristics (which gate on a "remote" signal) always evaluate the region.
    workMode: "Remote",
    title: j.title || "",
    company: j.company_name || "",
    companyLogo: j.company_logo || j.company_logo_url || "",
    category: j.category || "",
    jobType: j.job_type || "",
    candidate_required_location: j.candidate_required_location || "",
    salary: j.salary || "",
    url: j.url || "",
    publishedAt: j.publication_date || "",
    // Plain-text, capped — enough for eligibility heuristics + a preview.
    description: stripHtml(j.description).slice(0, 4000)
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders }
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const search = (url.searchParams.get("search") || "").trim().slice(0, 80);
  const category = (url.searchParams.get("category") || "").trim().slice(0, 60);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "30", 10) || 30, 1), MAX_LIMIT);

  const cacheKey = `discover/${category || "all"}__${search.toLowerCase() || "all"}__${limit}`;

  // Serve from the blob cache when it's still warm.
  let store = null;
  try { store = getStore("discover"); } catch (_) { store = null; }
  if (store) {
    try {
      const cached = await store.get(cacheKey, { type: "json" });
      if (cached && cached.ts && Date.now() - cached.ts < CACHE_TTL_MS) {
        return json({ jobs: cached.jobs, cached: true });
      }
    } catch (_) { /* cache miss — fall through to live fetch */ }
  }

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (category) params.set("category", category);
  params.set("limit", String(limit));

  let jobs = [];
  try {
    const r = await fetch(`${REMOTIVE_URL}?${params.toString()}`, {
      headers: { "user-agent": "JobTrail/1.0 (+https://jobtrail.cv)", accept: "application/json" }
    });
    if (!r.ok) return json({ error: "upstream", status: r.status, jobs: [] }, 502);
    const data = await r.json();
    jobs = Array.isArray(data.jobs) ? data.jobs.slice(0, limit).map(trimJob) : [];
  } catch (_) {
    return json({ error: "fetch_failed", jobs: [] }, 502);
  }

  if (store) {
    try { await store.setJSON(cacheKey, { ts: Date.now(), jobs }); } catch (_) { /* non-fatal */ }
  }

  return json({ jobs, cached: false });
};

export const config = { path: "/api/discover" };
