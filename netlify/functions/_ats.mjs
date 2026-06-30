// Shared ATS-board crawler (Greenhouse / Lever / Ashby). These are per-employer
// public APIs (no key), so we keep a curated seed of companies plus an
// auto-grown list (Netlify Blobs) of employers the user has tracked. Files
// prefixed with "_" are treated as helpers by Netlify, not deployed functions.
import { getStore } from "@netlify/blobs";

// Verified at build time to return jobs. Grouped by platform.
export const SEED_COMPANIES = {
  greenhouse: [
    "databricks", "stripe", "mongodb", "samsara", "brex", "cloudflare", "airbnb",
    "pinterest", "reddit", "affirm", "instacart", "twilio", "asana", "lyft",
    "gitlab", "robinhood", "coinbase", "postman", "sofi", "grafanalabs", "gusto",
    "faire", "monzo", "twitch", "discord", "dropbox", "gocardless", "squarespace",
    "circleci"
  ],
  lever: ["veeva", "palantir", "mistral", "matchgroup", "ro"],
  ashby: ["openai", "notion", "ramp", "cursor", "supabase", "watershed", "linear", "posthog", "mintlify"]
};

// Pretty display names where simple title-casing the token looks wrong.
const NAME_OVERRIDES = {
  openai: "OpenAI", gitlab: "GitLab", posthog: "PostHog", gocardless: "GoCardless",
  mongodb: "MongoDB", sofi: "SoFi", circleci: "CircleCI", matchgroup: "Match Group",
  grafanalabs: "Grafana Labs", veeva: "Veeva", ro: "Ro"
};

const UA = { "user-agent": "JobTrail/1.0 (+https://jobtrail.cv)", accept: "application/json" };
const TIMEOUT = 8000;

function titleCase(token) {
  if (NAME_OVERRIDES[token]) return NAME_OVERRIDES[token];
  return String(token || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
function locName(l) { if (!l) return ""; return typeof l === "string" ? l : (l.name || ""); }
function isRemoteLoc(s) { return /\bremote\b|work from home|\bwfh\b|anywhere|distributed/i.test(String(s || "")); }
function stripHtml(h) { return String(h || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }

async function gj(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try { const r = await fetch(url, { headers: UA, signal: c.signal }); if (!r.ok) return null; return await r.json(); }
  catch (_) { return null; }
  finally { clearTimeout(t); }
}

// Each adapter keeps only roles whose location reads as remote (the boards also
// carry on-site jobs), stamps workMode:Remote, and preserves the location text
// so downstream region-eligibility can narrow to what the user can actually do.
async function greenhouseJobs(token) {
  const d = await gj(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`);
  if (!d || !Array.isArray(d.jobs)) return [];
  return d.jobs
    .map((j) => ({ loc: locName(j.location), j }))
    .filter((x) => isRemoteLoc(x.loc))
    .map(({ loc, j }) => ({
      id: "gh-" + token + "-" + j.id, source: "Greenhouse", workMode: "Remote",
      company: j.company_name || titleCase(token), title: j.title,
      candidate_required_location: loc, salary: "",
      url: j.absolute_url, publishedAt: j.updated_at || j.first_published || "", description: ""
    }));
}
async function leverJobs(token) {
  const d = await gj(`https://api.lever.co/v0/postings/${token}?mode=json`);
  if (!Array.isArray(d)) return [];
  return d
    .map((j) => { const cats = j.categories || {}; return { loc: cats.location || (cats.allLocations || []).join(", ") || "", j }; })
    .filter((x) => isRemoteLoc(x.loc) || String(x.j.workplaceType).toLowerCase() === "remote")
    .map(({ loc, j }) => ({
      id: "lever-" + token + "-" + j.id, source: "Lever", workMode: "Remote",
      company: titleCase(token), title: j.text,
      candidate_required_location: loc || "Remote", salary: "",
      url: j.hostedUrl, publishedAt: j.createdAt ? new Date(j.createdAt).toISOString() : "",
      description: stripHtml(j.descriptionPlain).slice(0, 400)
    }));
}
async function ashbyJobs(token) {
  const d = await gj(`https://api.ashbyhq.com/posting-api/job-board/${token}`);
  if (!d || !Array.isArray(d.jobs)) return [];
  return d.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => { const sec = (j.secondaryLocations || []).map((s) => s.location).filter(Boolean); return { loc: [j.location, ...sec].filter(Boolean).join("; "), j }; })
    .filter((x) => isRemoteLoc(x.loc))
    .map(({ loc, j }) => ({
      id: "ashby-" + token + "-" + j.id, source: "Ashby", workMode: "Remote",
      company: titleCase(token), title: j.title,
      candidate_required_location: loc, salary: "",
      url: j.jobUrl, publishedAt: j.publishedAt || "", description: stripHtml(j.descriptionPlain).slice(0, 400)
    }));
}

// Fan out across every company with bounded concurrency; a slow/dead board just
// contributes nothing rather than failing the whole crawl.
export async function crawlCompanies(companies, { concurrency = 12 } = {}) {
  const tasks = [];
  (companies.greenhouse || []).forEach((t) => tasks.push(() => greenhouseJobs(t)));
  (companies.lever || []).forEach((t) => tasks.push(() => leverJobs(t)));
  (companies.ashby || []).forEach((t) => tasks.push(() => ashbyJobs(t)));
  const out = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try { const r = await tasks[idx](); if (r && r.length) out.push(...r); } catch (_) { /* skip board */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length || 1) }, () => worker()));
  return out;
}

// Curated seed + auto-grown tokens (Blobs), deduped per platform.
export async function loadCompanyList() {
  const merged = {
    greenhouse: [...SEED_COMPANIES.greenhouse],
    lever: [...SEED_COMPANIES.lever],
    ashby: [...SEED_COMPANIES.ashby]
  };
  try {
    const grown = await getStore("discover").get("ats-companies", { type: "json" });
    if (grown) {
      for (const p of ["greenhouse", "lever", "ashby"]) {
        if (Array.isArray(grown[p])) merged[p] = [...new Set([...merged[p], ...grown[p]])];
      }
    }
  } catch (_) { /* seed only */ }
  return merged;
}

export function countTokens(c) {
  return (c.greenhouse ? c.greenhouse.length : 0) + (c.lever ? c.lever.length : 0) + (c.ashby ? c.ashby.length : 0);
}
