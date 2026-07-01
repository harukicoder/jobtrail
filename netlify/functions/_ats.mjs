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
    "circleci", "anthropic", "remotecom", "adyen", "elastic", "clickhouse", "figma",
    "workato", "intercom", "fivetran", "dialpad", "vercel", "hightouch", "newrelic",
    "mercury", "vonage", "checkr", "amplitude", "fastly", "pendo", "tailscale",
    "mixpanel", "airtable", "launchdarkly", "marqeta", "cockroachlabs", "webflow",
    "gemini", "yugabyte", "alloy", "calendly", "starburst", "cultureamp",
    "planetscale", "lithic", "lattice", "stackblitz", "consensys", "dremio", "netlify"
  ],
  lever: [
    "veeva", "palantir", "mistral", "matchgroup", "ro", "spotify", "gopuff",
    "aircall", "secureframe", "angellist", "porter", "neon", "finch"
  ],
  ashby: [
    "openai", "notion", "ramp", "cursor", "supabase", "watershed", "linear",
    "posthog", "mintlify", "snowflake", "cohere", "plaid", "vanta", "replit",
    "kong", "clickup", "drata", "temporal", "confluent", "sentry", "miro", "modal",
    "gainsight", "poshmark", "persona", "render", "merge", "alchemy", "leapsome",
    "column", "oyster", "gorgias", "airbyte", "coder", "uniswap", "unit", "railway",
    "moderntreasury", "kustomer", "doppler", "paragon"
  ],
  workable: ["netguru", "zego"],
  smartrecruiters: ["experian", "servicenow", "devoteam", "visa", "boschgroup"],
  recruitee: ["hostaway", "timedoctor", "make"]
};

export const PLATFORMS = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee"];

// Pretty display names where simple title-casing the token looks wrong.
const NAME_OVERRIDES = {
  openai: "OpenAI", gitlab: "GitLab", posthog: "PostHog", gocardless: "GoCardless",
  mongodb: "MongoDB", sofi: "SoFi", circleci: "CircleCI", matchgroup: "Match Group",
  grafanalabs: "Grafana Labs", veeva: "Veeva", ro: "Ro", clickup: "ClickUp",
  moderntreasury: "Modern Treasury", angellist: "AngelList", remotecom: "Remote",
  cultureamp: "Culture Amp", servicenow: "ServiceNow", boschgroup: "Bosch Group",
  timedoctor: "Time Doctor"
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

// Workable widget API: telecommuting=true marks remote roles. Verified shape:
// { name, jobs: [{ title, url, country, city, telecommuting, published_on }] }.
async function workableJobs(token) {
  const d = await gj(`https://apply.workable.com/api/v1/widget/accounts/${token}`);
  if (!d || !Array.isArray(d.jobs)) return [];
  return d.jobs
    .filter((j) => j.telecommuting === true || isRemoteLoc([j.city, j.state].join(" ")))
    .map((j) => ({
      id: "workable-" + token + "-" + (j.shortcode || j.code || j.url), source: "Workable", workMode: "Remote",
      company: d.name || titleCase(token), title: j.title,
      candidate_required_location: ["Remote", [j.city, j.country].filter(Boolean).join(", ")].filter(Boolean).join(" — "),
      salary: "", url: j.url, publishedAt: j.published_on || "", description: ""
    }));
}
// SmartRecruiters public postings API (case-insensitive company identifier).
// location.remote is an explicit boolean; posting page is jobs.smartrecruiters.com/{co}/{id}.
async function smartrecruitersJobs(token) {
  const d = await gj(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`);
  if (!d || !Array.isArray(d.content)) return [];
  return d.content
    .filter((j) => j.location && j.location.remote === true)
    .map((j) => ({
      id: "smartrec-" + token + "-" + j.id, source: "SmartRecruiters", workMode: "Remote",
      company: (j.company && (j.company.name || j.company.identifier)) || titleCase(token),
      title: j.name,
      candidate_required_location: ["Remote", j.location.fullLocation || [j.location.city, j.location.country].filter(Boolean).join(", ")].filter(Boolean).join(" — "),
      salary: "", url: `https://jobs.smartrecruiters.com/${token}/${j.id}`,
      publishedAt: j.releasedDate || "", description: ""
    }));
}
// Recruitee per-company offers API ({token}.recruitee.com/api/offers/).
async function recruiteeJobs(token) {
  const d = await gj(`https://${token}.recruitee.com/api/offers/`);
  if (!d || !Array.isArray(d.offers)) return [];
  return d.offers
    .filter((j) => j.remote === true || isRemoteLoc(j.location))
    .map((j) => {
      const s = j.salary || {};
      const salary = (s.min || s.max)
        ? `${s.currency || ""}${s.min || s.max}${s.max && s.min && s.max !== s.min ? " - " + (s.currency || "") + s.max : ""}${s.period ? "/" + s.period : ""}`
        : "";
      let published = "";
      try { const dte = new Date(j.published_at || j.created_at); if (!isNaN(dte.getTime())) published = dte.toISOString(); } catch (_) { /* leave blank */ }
      return {
        id: "recruitee-" + token + "-" + (j.guid || j.title), source: "Recruitee", workMode: "Remote",
        company: j.company_name || titleCase(token), title: j.title,
        candidate_required_location: [j.location, j.country].filter(Boolean).join(", ") || "Remote",
        salary, url: j.careers_url, publishedAt: published,
        description: stripHtml(j.requirements || "").slice(0, 400)
      };
    });
}

// Fan out across every company with bounded concurrency; a slow/dead board just
// contributes nothing rather than failing the whole crawl.
export async function crawlCompanies(companies, { concurrency = 12 } = {}) {
  const tasks = [];
  (companies.greenhouse || []).forEach((t) => tasks.push(() => greenhouseJobs(t)));
  (companies.lever || []).forEach((t) => tasks.push(() => leverJobs(t)));
  (companies.ashby || []).forEach((t) => tasks.push(() => ashbyJobs(t)));
  (companies.workable || []).forEach((t) => tasks.push(() => workableJobs(t)));
  (companies.smartrecruiters || []).forEach((t) => tasks.push(() => smartrecruitersJobs(t)));
  (companies.recruitee || []).forEach((t) => tasks.push(() => recruiteeJobs(t)));
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
  const merged = {};
  PLATFORMS.forEach((p) => { merged[p] = [...(SEED_COMPANIES[p] || [])]; });
  try {
    const grown = await getStore("discover").get("ats-companies", { type: "json" });
    if (grown) {
      for (const p of PLATFORMS) {
        if (Array.isArray(grown[p])) merged[p] = [...new Set([...merged[p], ...grown[p]])];
      }
    }
  } catch (_) { /* seed only */ }
  return merged;
}

export function countTokens(c) {
  return PLATFORMS.reduce((n, p) => n + ((c[p] && c[p].length) || 0), 0);
}

// Probe every platform for a live board under `token`. Shared by the resolver
// (user "follow company" lookups) and the weekly auto-grow crawler.
export async function probeToken(token) {
  const [gh, lv, as, wk, sr, rc] = await Promise.all([
    gj(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`),
    gj(`https://api.lever.co/v0/postings/${token}?mode=json`),
    gj(`https://api.ashbyhq.com/posting-api/job-board/${token}`),
    gj(`https://apply.workable.com/api/v1/widget/accounts/${token}`),
    gj(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=1`),
    gj(`https://${token}.recruitee.com/api/offers/`)
  ]);
  const matches = [];
  const ghN = gh && Array.isArray(gh.jobs) ? gh.jobs.length : 0;
  if (ghN) matches.push({ platform: "greenhouse", token, count: ghN, company: (gh.jobs[0] && gh.jobs[0].company_name) || token });
  if (Array.isArray(lv) && lv.length) matches.push({ platform: "lever", token, count: lv.length, company: token });
  const asN = as && Array.isArray(as.jobs) ? as.jobs.length : 0;
  if (asN) matches.push({ platform: "ashby", token, count: asN, company: token });
  const wkN = wk && Array.isArray(wk.jobs) ? wk.jobs.length : 0;
  if (wkN) matches.push({ platform: "workable", token, count: wkN, company: wk.name || token });
  const srN = sr && typeof sr.totalFound === "number" ? sr.totalFound : 0;
  if (srN) matches.push({ platform: "smartrecruiters", token, count: srN, company: token });
  const rcN = rc && Array.isArray(rc.offers) ? rc.offers.length : 0;
  if (rcN) matches.push({ platform: "recruitee", token, count: rcN, company: (rc.offers[0] && rc.offers[0].company_name) || token });
  return matches;
}
