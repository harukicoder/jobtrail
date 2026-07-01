import { getStore } from "@netlify/blobs";

// Auto-grow: the webapp POSTs the Greenhouse/Lever/Ashby board tokens of roles
// the user has tracked, so the next crawl pulls those employers' full boards.
// Body: { companies: [{ platform, token }, ...] } or a single { platform, token }.
const PLATFORMS = new Set(["greenhouse", "lever", "ashby"]);
const VALID_TOKEN = /^[a-z0-9][a-z0-9-]{0,60}$/;
const MAX_PER_PLATFORM = 2000; // guard against unbounded growth

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

export default async (req) => {
  const store = getStore("discover");
  const load = async () => {
    let cur = {};
    try { cur = (await store.get("ats-companies", { type: "json" })) || {}; } catch (_) { cur = {}; }
    cur.greenhouse = cur.greenhouse || [];
    cur.lever = cur.lever || [];
    cur.ashby = cur.ashby || [];
    return cur;
  };

  // GET → list the followed (auto-grown + explicitly added) companies.
  if (req.method === "GET") {
    return json({ ok: true, companies: await load() });
  }
  if (req.method !== "POST") return json({ error: "GET or POST only" }, 405);

  let body = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const cur = await load();

  // Unfollow: { remove: { platform, token } }
  if (body.remove) {
    const p = String(body.remove.platform || "").toLowerCase();
    const t = String(body.remove.token || "").toLowerCase().trim();
    let removed = 0;
    if (PLATFORMS.has(p) && cur[p].includes(t)) { cur[p] = cur[p].filter((x) => x !== t); removed = 1; }
    if (removed) { try { await store.setJSON("ats-companies", cur); } catch (_) { /* non-fatal */ } }
    return json({ ok: true, removed, companies: cur });
  }

  const items = Array.isArray(body.companies) ? body.companies : [body];
  let added = 0;
  for (const it of items) {
    const p = String((it && it.platform) || "").toLowerCase();
    const t = String((it && it.token) || "").toLowerCase().trim();
    if (!PLATFORMS.has(p) || !VALID_TOKEN.test(t)) continue;
    if (!cur[p].includes(t) && cur[p].length < MAX_PER_PLATFORM) { cur[p].push(t); added += 1; }
  }
  if (added) { try { await store.setJSON("ats-companies", cur); } catch (_) { /* non-fatal */ } }

  return json({ ok: true, added, companies: cur });
};

export const config = { path: "/api/ats-company" };
