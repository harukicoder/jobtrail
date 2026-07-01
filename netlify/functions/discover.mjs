import { getStore } from "@netlify/blobs";

// Discover feed: aggregate live remote roles from several public job boards
// (no API keys needed), normalise them into one shape, dedupe across sources,
// and return a merged, freshness-sorted list. The static webapp consumes this
// for both the manual Discover search and the daily "Today's picks" batch.
//
// Each board's terms require crediting them + linking back to their posting —
// we satisfy that by keeping each job's source label and its original URL
// (the card's "View posting" link points there).

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — fresh enough, polite to sources.
const PER_SOURCE = 40;               // cap per board before merging
const MERGED_MAX = 700;              // hard cap on the returned list (daily picks pull a big pool then filter/rank down)
const FETCH_TIMEOUT_MS = 9000;

const UA = { "user-agent": "JobTrail/1.0 (+https://jobtrail.cv)", accept: "application/json" };

// Heuristic to drop German-language Arbeitnow posts (it's a DE/EU board that
// mixes languages); our audience reads English.
const DE_RE = /[äöüß]|\b(m\/w\/d|w\/m\/d|gesucht|mitarbeiter|wir suchen|stelle|ausbildung|praktikum|vollzeit)\b/i;

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Decode HTML/XML entities that feed titles carry (WeWorkRemotely's RSS encodes
// "&" as "&amp;", plus numeric entities like "&#39;"). Named "&amp;" is decoded
// first so double-encoded sequences ("&amp;#39;") resolve in one pass.
function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ""; } })
    .replace(/&#(\d+);/g, (_m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return ""; } });
}

function normalize(j) {
  return {
    id: String(j.id || ""),
    source: j.source || "",
    workMode: "Remote", // every source here is remote-only by construction
    title: decodeEntities(String(j.title || "").trim()),
    company: decodeEntities(String(j.company || "").trim()),
    companyLogo: j.companyLogo || "",
    category: j.category || "",
    jobType: j.jobType || "",
    candidate_required_location: decodeEntities(String(j.candidate_required_location || "").trim()),
    salary: String(j.salary || "").trim(),
    url: j.url || "",
    publishedAt: j.publishedAt || "",
    description: decodeEntities(stripHtml(j.description)).slice(0, 4000)
  };
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}
async function getText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { ...UA, accept: "application/rss+xml, text/xml" }, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

// ---- per-source adapters (each returns [] on failure, never throws) --------

async function fromRemotive(search, category) {
  const p = new URLSearchParams();
  if (search) p.set("search", search);
  if (category) p.set("category", category);
  p.set("limit", String(PER_SOURCE));
  const d = await getJson("https://remotive.com/api/remote-jobs?" + p.toString());
  if (!d || !Array.isArray(d.jobs)) return [];
  return d.jobs.slice(0, PER_SOURCE).map((j) => ({
    id: "remotive-" + j.id, source: "Remotive",
    title: j.title, company: j.company_name, companyLogo: j.company_logo,
    category: j.category, jobType: j.job_type,
    candidate_required_location: j.candidate_required_location,
    salary: j.salary, url: j.url, publishedAt: j.publication_date, description: j.description
  }));
}

async function fromRemoteOK() {
  const arr = await getJson("https://remoteok.com/api");
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => x && x.id && x.position).slice(0, PER_SOURCE).map((j) => {
    const min = Number(j.salary_min) || 0, max = Number(j.salary_max) || 0;
    const salary = (min || max) ? `$${min || max}${max && max !== min ? " - $" + max : ""}` : "";
    return {
      id: "remoteok-" + j.id, source: "RemoteOK",
      title: j.position, company: j.company, companyLogo: j.company_logo || j.logo,
      category: (j.tags && j.tags[0]) || "", jobType: "",
      candidate_required_location: j.location || "Worldwide",
      salary, url: j.url || j.apply_url, publishedAt: j.date, description: j.description
    };
  });
}

async function fromJobicy(search) {
  const p = new URLSearchParams();
  p.set("count", String(PER_SOURCE));
  if (search) p.set("tag", search);
  const d = await getJson("https://jobicy.com/api/v2/remote-jobs?" + p.toString());
  if (!d || !Array.isArray(d.jobs)) return [];
  return d.jobs.slice(0, PER_SOURCE).map((j) => {
    const cur = j.salaryCurrency || "";
    const sym = cur === "USD" ? "$" : cur === "EUR" ? "€" : cur === "GBP" ? "£" : (cur ? cur + " " : "");
    const min = Number(j.salaryMin) || 0, max = Number(j.salaryMax) || 0;
    const salary = (min || max) ? `${sym}${min || max}${max && max !== min ? " - " + sym + max : ""}` : "";
    return {
      id: "jobicy-" + j.id, source: "Jobicy",
      title: j.jobTitle, company: j.companyName, companyLogo: j.companyLogo,
      category: j.jobIndustry, jobType: Array.isArray(j.jobType) ? j.jobType.join(", ") : j.jobType,
      candidate_required_location: j.jobGeo,
      salary, url: j.url, publishedAt: j.pubDate, description: j.jobExcerpt || j.jobDescription
    };
  });
}

async function fromArbeitnow() {
  const d = await getJson("https://www.arbeitnow.com/api/job-board-api");
  if (!d || !Array.isArray(d.data)) return [];
  return d.data
    .filter((j) => j.remote === true && !DE_RE.test(j.title || ""))
    .slice(0, PER_SOURCE)
    .map((j) => ({
      id: "arbeitnow-" + j.slug, source: "Arbeitnow",
      title: j.title, company: j.company_name,
      category: (j.tags && j.tags[0]) || "",
      jobType: Array.isArray(j.job_types) ? j.job_types.join(", ") : "",
      candidate_required_location: j.location || "Europe",
      salary: "", url: j.url,
      publishedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : "",
      description: j.description
    }));
}

async function fromWWR() {
  const xml = await getText("https://weworkremotely.com/remote-jobs.rss");
  if (!xml) return [];
  const blocks = xml.split("<item>").slice(1).map((s) => s.split("</item>")[0]);
  const pick = (s, tag) => {
    const m = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">").exec(s);
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
  };
  return blocks.slice(0, PER_SOURCE).map((s, i) => {
    const rawTitle = pick(s, "title");      // "Company: Role"
    const idx = rawTitle.indexOf(":");
    const company = idx > 0 ? rawTitle.slice(0, idx).trim() : "";
    let title = idx > 0 ? rawTitle.slice(idx + 1).trim() : rawTitle;
    title = title.replace(/^(job title|hiring|now hiring|role)\s*:\s*/i, "").trim();
    const link = pick(s, "link");
    return {
      id: "wwr-" + (link.split("/").filter(Boolean).pop() || i), source: "WeWorkRemotely",
      title, company, category: pick(s, "category"), jobType: pick(s, "type"),
      candidate_required_location: pick(s, "region") || "Anywhere",
      salary: "", url: link, publishedAt: pick(s, "pubDate"), description: pick(s, "description")
    };
  });
}

// ---- merge helpers ---------------------------------------------------------

function normKey(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function dedupe(jobs) {
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    if (!j.title || !j.url) continue;
    // Strip "remote"/"(remote)" noise so the same role on two boards collapses.
    const titleKey = normKey(j.title).replace(/\bremote\b/g, " ").replace(/\s+/g, " ").trim();
    const key = titleKey + "@" + normKey(j.company);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

function matchesSearch(j, terms) {
  if (!terms.length) return true;
  const hay = (j.title + " " + j.company + " " + j.category + " " + j.description).toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function tsOf(j) { const t = new Date(j.publishedAt).getTime(); return isNaN(t) ? 0 : t; }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const search = (url.searchParams.get("search") || "").trim().slice(0, 80);
  const category = (url.searchParams.get("category") || "").trim().slice(0, 60);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), MERGED_MAX);

  const cacheKey = `discover/${category || "all"}__${search.toLowerCase() || "all"}__${limit}`;

  let store = null;
  try { store = getStore("discover"); } catch (_) { store = null; }
  if (store) {
    try {
      const cached = await store.get(cacheKey, { type: "json" });
      if (cached && cached.ts && Date.now() - cached.ts < CACHE_TTL_MS) {
        return json({ jobs: cached.jobs, sources: cached.sources, cached: true });
      }
    } catch (_) { /* fall through to live fetch */ }
  }

  // Fetch every source in parallel; a slow/broken board just contributes [].
  const settled = await Promise.all([
    fromRemotive(search, category),
    fromRemoteOK(),
    fromJobicy(search),
    fromArbeitnow(),
    fromWWR()
  ]);
  const sourceNames = ["Remotive", "RemoteOK", "Jobicy", "Arbeitnow", "WeWorkRemotely"];
  const sources = {};
  settled.forEach((list, i) => { sources[sourceNames[i]] = list.length; });

  // Roles crawled from Greenhouse/Lever/Ashby company boards, refreshed
  // separately by /api/ats-refresh and cached in the same store.
  let atsJobs = [];
  if (store) {
    try { const a = await store.get("ats-latest", { type: "json" }); if (a && Array.isArray(a.jobs)) atsJobs = a.jobs; } catch (_) { atsJobs = []; }
  }
  sources["ATS boards"] = atsJobs.length;

  const terms = search ? search.toLowerCase().split(/\s+/).filter(Boolean) : [];
  let merged = dedupe([].concat(...settled, atsJobs).map(normalize))
    .filter((j) => matchesSearch(j, terms))
    .sort((a, b) => tsOf(b) - tsOf(a))
    .slice(0, limit);

  if (store) {
    try { await store.setJSON(cacheKey, { ts: Date.now(), jobs: merged, sources }); } catch (_) { /* non-fatal */ }
    // Auto-grow feedstock: companies seen on the job boards become candidate
    // ATS tokens; the weekly ats-autogrow function probes them and follows any
    // that turn out to have a live Greenhouse/Lever/Ashby/etc. board.
    try {
      const DIRECT = new Set(["Greenhouse", "Lever", "Ashby", "Workable", "SmartRecruiters", "Recruitee"]);
      const tokens = [...new Set(
        merged.filter((j) => !DIRECT.has(j.source))
          .map((j) => String(j.company || "").toLowerCase().replace(/[^a-z0-9]+/g, ""))
          .filter((t) => t.length >= 3 && t.length <= 30)
      )];
      if (tokens.length) {
        const existing = (await store.get("ats-candidates", { type: "json" })) || [];
        const probed = new Set((await store.get("ats-probed", { type: "json" })) || []);
        const queue = [...new Set([...existing, ...tokens])].filter((t) => !probed.has(t)).slice(-400);
        await store.setJSON("ats-candidates", queue);
      }
    } catch (_) { /* non-fatal */ }
  }

  return json({ jobs: merged, sources, cached: false });
};

export const config = { path: "/api/discover" };
