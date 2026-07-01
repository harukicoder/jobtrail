// Resolve a company name/handle to its ATS board(s). Probes all supported
// platforms (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee)
// for a board under that token and reports which have live jobs, so the webapp
// can let the user "follow" a company and pull its roles.
import { probeToken } from "./_ats.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

export default async (req) => {
  const raw = (new URL(req.url).searchParams.get("name") || "").trim().toLowerCase();
  // Board tokens are lowercase alphanumeric handles; strip everything else
  // and collapse spaces (e.g. "Match Group" -> "matchgroup").
  const token = raw.replace(/[^a-z0-9-]+/g, "");
  if (!token || token.length < 2) return json({ query: raw, matches: [] });

  const matches = await probeToken(token);
  return json({ query: token, matches });
};

export const config = { path: "/api/ats-resolve" };
