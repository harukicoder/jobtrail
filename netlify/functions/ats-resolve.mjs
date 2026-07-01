// Resolve a company name/handle to its ATS board(s). Probes Greenhouse, Lever
// and Ashby for a board under that token and reports which have live jobs, so
// the webapp can let the user "follow" a company and pull its roles.
const UA = { "user-agent": "JobTrail/1.0 (+https://jobtrail.cv)", accept: "application/json" };
const TIMEOUT = 8000;

async function gj(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try { const r = await fetch(url, { headers: UA, signal: c.signal }); if (!r.ok) return null; return await r.json(); }
  catch (_) { return null; }
  finally { clearTimeout(t); }
}

async function tryGreenhouse(token) {
  const d = await gj(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`);
  const jobs = d && Array.isArray(d.jobs) ? d.jobs : [];
  if (!jobs.length) return null;
  return { platform: "greenhouse", token, count: jobs.length, company: (jobs[0] && jobs[0].company_name) || token };
}
async function tryLever(token) {
  const d = await gj(`https://api.lever.co/v0/postings/${token}?mode=json`);
  if (!Array.isArray(d) || !d.length) return null;
  return { platform: "lever", token, count: d.length, company: token };
}
async function tryAshby(token) {
  const d = await gj(`https://api.ashbyhq.com/posting-api/job-board/${token}`);
  const jobs = d && Array.isArray(d.jobs) ? d.jobs : [];
  if (!jobs.length) return null;
  return { platform: "ashby", token, count: jobs.length, company: token };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

export default async (req) => {
  const raw = (new URL(req.url).searchParams.get("name") || "").trim().toLowerCase();
  // Company boards are lowercase alphanumeric handles; strip everything else
  // and collapse spaces (e.g. "Match Group" -> "matchgroup").
  const token = raw.replace(/[^a-z0-9-]+/g, "");
  if (!token || token.length < 2) return json({ query: raw, matches: [] });

  const results = await Promise.all([tryGreenhouse(token), tryLever(token), tryAshby(token)]);
  return json({ query: token, matches: results.filter(Boolean) });
};

export const config = { path: "/api/ats-resolve" };
