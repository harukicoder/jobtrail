import { getStore } from "@netlify/blobs";

// Superuser-only analytics aggregation. Authorization is the signed-in Google
// identity: the caller sends their Drive access token as `Authorization:
// Bearer …`, and we resolve it server-side via Drive's about endpoint. Only
// OWNER_EMAIL (env override, default below) is allowed. Aggregate counts only.
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "haruki.kimura.jp@gmail.com").toLowerCase();

function topN(map, n, keyName) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ [keyName]: k, count: v }));
}

function forbidden() {
  return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
}

export default async (req) => {
  const url = new URL(req.url);

  const accessToken = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) return forbidden();
  let email = "";
  try {
    const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", { headers: { Authorization: "Bearer " + accessToken } });
    if (r.ok) { const j = await r.json(); email = ((j.user && j.user.emailAddress) || "").toLowerCase(); }
  } catch (_) { /* email stays empty -> forbidden */ }
  if (!email || email !== OWNER_EMAIL) return forbidden();

  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1), 120);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const store = getStore("analytics");
  let blobs = [];
  try {
    const listed = await store.list({ prefix: "ev/" });
    blobs = (listed && listed.blobs) || [];
  } catch (_) { blobs = []; }

  // Keys look like ev/YYYY-MM-DD/...; cheap date filter before reading.
  const recent = blobs.filter((b) => {
    const m = /^ev\/(\d{4}-\d{2}-\d{2})\//.exec(b.key);
    return m && m[1] >= cutoff;
  });

  const events = [];
  await Promise.all(recent.map(async (b) => {
    try { const e = await store.get(b.key, { type: "json" }); if (e) events.push(e); } catch (_) { /* skip */ }
  }));

  const visitors = new Set();
  const signinVisitors = new Set();
  const byDay = {};
  const ref = {};
  const country = {};
  const path = {};
  const devices = { mobile: 0, desktop: 0 };
  const byVisitor = {};
  let pageviews = 0, signins = 0;

  events.forEach((e) => {
    const day = String(e.ts || "").slice(0, 10);
    if (!byDay[day]) byDay[day] = { day, pageviews: 0, signins: 0, visitors: new Set() };
    if (e.s) byDay[day].visitors.add(e.s);

    // Per-visitor profile (one row per anonymous visitor id).
    if (e.s) {
      let v = byVisitor[e.s];
      if (!v) v = byVisitor[e.s] = { sid: e.s, firstTs: e.ts, lastTs: e.ts, visits: 0, signins: 0, country: "", city: "", device: "", lang: "", tz: "", source: "", _srcTs: null };
      if (e.ts > v.lastTs) v.lastTs = e.ts;
      if (e.ts < v.firstTs) v.firstTs = e.ts;
      if (e.c) v.country = e.c;
      if (e.city) v.city = e.city;
      if (e.d) v.device = e.d;
      if (e.l) v.lang = e.l;
      if (e.tz) v.tz = e.tz;
      if (e.t === "signin") { v.signins += 1; }
      else {
        v.visits += 1;
        if (v._srcTs === null || e.ts < v._srcTs) { v._srcTs = e.ts; v.source = e.r || "direct"; }
      }
    }

    if (e.t === "signin") {
      signins += 1;
      byDay[day].signins += 1;
      if (e.s) signinVisitors.add(e.s);
    } else {
      pageviews += 1;
      byDay[day].pageviews += 1;
      if (e.s) visitors.add(e.s);
      ref[e.r || "direct"] = (ref[e.r || "direct"] || 0) + 1;
      if (e.c) country[e.c] = (country[e.c] || 0) + 1;
      path[e.p || "/"] = (path[e.p || "/"] || 0) + 1;
      if (e.d === "mobile") devices.mobile += 1; else devices.desktop += 1;
    }
  });

  const visitorRows = Object.values(byVisitor)
    .sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1))
    .slice(0, 100)
    .map((v) => ({
      sid: v.sid,
      lastSeen: v.lastTs,
      firstSeen: v.firstTs,
      visits: v.visits,
      country: v.country,
      city: v.city,
      tz: v.tz,
      device: v.device || "unknown",
      lang: v.lang,
      source: v.source || "direct",
      signedIn: v.signins > 0
    }));

  const result = {
    rangeDays: days,
    totals: {
      visitors: visitors.size,
      pageviews,
      signins,
      signedInVisitors: signinVisitors.size
    },
    byDay: Object.values(byDay)
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((d) => ({ day: d.day, pageviews: d.pageviews, signins: d.signins, visitors: d.visitors.size })),
    topReferrers: topN(ref, 8, "name"),
    topCountries: topN(country, 8, "code"),
    topPaths: topN(path, 8, "path"),
    devices,
    visitors: visitorRows
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};

export const config = { path: "/api/stats" };
