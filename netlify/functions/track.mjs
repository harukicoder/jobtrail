import { getStore } from "@netlify/blobs";

// Ingest a single analytics event. One blob per event (unique key) so there's
// no read-modify-write race; stats.mjs lists + aggregates them. Best-effort:
// any failure is swallowed so tracking never affects the visitor's page.
const ALLOWED = new Set(["pageview", "signin"]);

function corsHeaders(req) {
  return {
    "access-control-allow-origin": req.headers.get("origin") || "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders(req) });

  let body = {};
  try { body = await req.json(); } catch (_) { body = {}; }

  const type = ALLOWED.has(body.type) ? body.type : "pageview";
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const geo = (context && context.geo) || {};
  const ua = req.headers.get("user-agent") || "";
  const device = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? "mobile" : "desktop";

  let refHost = "direct";
  try {
    if (body.ref) {
      const h = new URL(body.ref).hostname.replace(/^www\./, "");
      if (h) refHost = h;
    }
  } catch (_) { /* keep "direct" */ }
  // A referrer pointing at our own host is really a direct/internal visit.
  try {
    const self = new URL(req.url).hostname.replace(/^www\./, "");
    if (refHost === self) refHost = "direct";
  } catch (_) { /* ignore */ }

  const event = {
    t: type,
    p: String(body.path || "/").slice(0, 200),
    r: refHost.slice(0, 120),
    c: (geo.country && geo.country.code) || "",
    city: String(geo.city || "").slice(0, 80),
    d: device,
    s: String(body.sid || "").slice(0, 40),
    ts: now.toISOString()
  };

  try {
    const store = getStore("analytics");
    const key = `ev/${day}/${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    await store.setJSON(key, event);
  } catch (_) { /* best-effort — never fail the beacon */ }

  return new Response(null, { status: 204, headers: corsHeaders(req) });
};

export const config = { path: "/api/track" };
