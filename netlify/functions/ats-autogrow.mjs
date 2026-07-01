import { getStore } from "@netlify/blobs";
import { probeToken, loadCompanyList, PLATFORMS } from "./_ats.mjs";

// Weekly auto-grow: company names spotted on the job-board feeds are queued as
// candidate ATS tokens (by discover.mjs); this scheduled function probes a
// small batch across all six platforms and follows any with a live board.
// Probed tokens are remembered (hit or miss) so they're never re-probed, and
// the batch is kept small to fit the scheduled-function execution budget.
const BATCH = 10;

export default async () => {
  const store = getStore("discover");
  let candidates = [];
  let probed = [];
  try { candidates = (await store.get("ats-candidates", { type: "json" })) || []; } catch (_) { candidates = []; }
  try { probed = (await store.get("ats-probed", { type: "json" })) || []; } catch (_) { probed = []; }
  const probedSet = new Set(probed);

  const known = await loadCompanyList();
  const knownSet = new Set();
  PLATFORMS.forEach((p) => (known[p] || []).forEach((t) => knownSet.add(t)));

  const queue = candidates.filter((t) => !probedSet.has(t) && !knownSet.has(t)).slice(0, BATCH);
  if (!queue.length) return;

  let cur = {};
  try { cur = (await store.get("ats-companies", { type: "json" })) || {}; } catch (_) { cur = {}; }
  PLATFORMS.forEach((p) => { cur[p] = cur[p] || []; });

  let added = 0;
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const t = queue[i++];
      try {
        const matches = await probeToken(t);
        matches.forEach((m) => {
          if (!cur[m.platform].includes(m.token)) { cur[m.platform].push(m.token); added += 1; }
        });
      } catch (_) { /* count as probed anyway */ }
      probedSet.add(t);
    }
  }
  // 3 tokens in flight = 18 concurrent probes max — quick, and safely inside
  // the scheduled-function time limit.
  await Promise.all([worker(), worker(), worker()]);

  try {
    if (added) await store.setJSON("ats-companies", cur);
    await store.setJSON("ats-probed", [...probedSet].slice(-5000));
    await store.setJSON("ats-candidates", candidates.filter((t) => !probedSet.has(t)).slice(-400));
  } catch (_) { /* retry next week */ }
};

export const config = { schedule: "@weekly" };
