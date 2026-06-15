import { getStore } from "@netlify/blobs";

// Owner-only analytics aggregation. The caller must present the shared secret
// (set as the ANALYTICS_TOKEN env var in Netlify) via the x-analytics-token
// header or ?token=. Returns aggregate counts only — no personal data.

function topN(map, n, keyName) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ [keyName]: k, count: v }));
}

export default async (req) => {
  const url = new URL(req.url);
  const expected = process.env.ANALYTICS_TOKEN || "";
  const token = req.headers.get("x-analytics-token") || url.searchParams.get("token") || "";
  if (!expected || token !== expected) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
  }

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
  let pageviews = 0, signins = 0;

  events.forEach((e) => {
    const day = String(e.ts || "").slice(0, 10);
    if (!byDay[day]) byDay[day] = { day, pageviews: 0, signins: 0, visitors: new Set() };
    if (e.s) byDay[day].visitors.add(e.s);
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
    devices
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};

export const config = { path: "/api/stats" };
