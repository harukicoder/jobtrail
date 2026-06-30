(function initJobCRMData(globalScope) {
  const STORAGE_KEY = "teal_job_crm_records_v1";
  const SNAPSHOT_KEY = "jobtrail_snapshots_v1";
  const PROFILE_KEY = "jobtrail_profile_v1";
  const AUTOFILL_MAPPINGS_KEY = "jobtrail_autofill_mappings_v1";
  const MAX_SNAPSHOTS = 8;
  const MAX_MAPPINGS_PER_HOST = 60;

  const PROFILE_COMMON_FIELDS = [
    "firstName",
    "lastName",
    "fullName",
    "email",
    "phone",
    "city",
    "country",
    "location",
    "currentCompany",
    "currentTitle",
    "linkedinUrl",
    "githubUrl",
    "portfolioUrl"
  ];

  const PROFILE_SECTION_FIELDS = [
    "yearsExperience",
    "desiredSalary",
    "workAuthorization",
    "coverLetter",
    "resumeText",
    "preferredStartDate",
    "noticePeriod"
  ];

  const PROFILE_FIELDS = PROFILE_COMMON_FIELDS.concat(PROFILE_SECTION_FIELDS);

  const DEFAULT_SECTIONS = [
    { id: "full-time", name: "Full-time" },
    { id: "part-time", name: "Part-time" },
    { id: "self-employed", name: "Self-employed" }
  ];
  const PRIMARY_STORAGE_AREA = "sync";
  const FALLBACK_STORAGE_AREA = "local";
  const STATUS_ORDER = [
    "bookmarked",
    "applying",
    "applied",
    "interviewing",
    "offer",
    "rejected",
    "archived"
  ];

  const STATUS_META = {
    bookmarked: { label: "Bookmarked", badge: "BM", color: "#86b9b0" },
    applying: { label: "Applying", badge: "IP", color: "#4b978b" },
    applied: { label: "Applied", badge: "AP", color: "#0f766e" },
    interviewing: { label: "Interviewing", badge: "IV", color: "#c58b47" },
    offer: { label: "Offer", badge: "OF", color: "#3e956a" },
    rejected: { label: "Rejected", badge: "NO", color: "#9e5c63" },
    archived: { label: "Archived", badge: "AR", color: "#6b7280" }
  };

  const SIGNIFICANT_QUERY_KEYS = [
    "currentJobId",
    "gh_jid",
    "gh_src",
    "jid",
    "jobid",
    "job_id",
    "jobId",
    "jk",
    "lever-source",
    "lever-via",
    "postingId",
    "reqid",
    "vacancyId"
  ];

  const JOB_ID_QUERY_KEYS = [
    "currentJobId",
    "gh_jid",
    "jid",
    "jobid",
    "job_id",
    "jobId",
    "jk",
    "postingId",
    "reqid",
    "vacancyId"
  ];

  function promisifyChrome(methodOwner, methodName, args) {
    return new Promise((resolve, reject) => {
      methodOwner[methodName](...args, (result) => {
        const error = globalScope.chrome && globalScope.chrome.runtime
          ? globalScope.chrome.runtime.lastError
          : null;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(result);
      });
    });
  }

  function getStorageArea(areaName) {
    if (!globalScope.chrome || !globalScope.chrome.storage) {
      throw new Error("Chrome storage is unavailable.");
    }

    return areaName === PRIMARY_STORAGE_AREA && globalScope.chrome.storage.sync
      ? globalScope.chrome.storage.sync
      : globalScope.chrome.storage.local;
  }

  function storageGet(areaName, key) {
    return promisifyChrome(getStorageArea(areaName), "get", [key]);
  }

  function storageSet(areaName, value) {
    return promisifyChrome(getStorageArea(areaName), "set", [value]);
  }

  function storageRemove(areaName, key) {
    return promisifyChrome(getStorageArea(areaName), "remove", [key]);
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[_|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function toTitleCase(value) {
    return String(value || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
      .join(" ");
  }

  // A name entered in ALL CAPS or all-lowercase looks wrong when typed into a
  // form. Title-case those, but leave intentionally mixed-case names untouched
  // (McDonald, O'Brien, van der Berg) so we never "correct" a real name.
  function normalizeNameCase(value) {
    const name = String(value || "").trim();
    if (!name) return "";
    const isAllCaps = name === name.toUpperCase();
    const isAllLower = name === name.toLowerCase();
    if (!isAllCaps && !isAllLower) return name;
    return name
      .toLowerCase()
      .replace(/(^|[\s'’\-])([a-zà-öø-ÿ])/g, (m, sep, ch) => sep + ch.toUpperCase());
  }

  // Job-board / ATS platforms that put the EMPLOYER in the URL path
  // (job-boards.greenhouse.io/gitlab/jobs/123 -> "gitlab") or in a company
  // subdomain (acme.workable.com). The bare-subdomain heuristic used to read
  // these as "Job Boards" / "Jobs", so handle the known platforms explicitly.
  const ATS_PATH_ROOTS = [
    "greenhouse.io", "lever.co", "ashbyhq.com", "smartrecruiters.com",
    "workable.com", "breezy.hr", "jobvite.com", "teamtailor.com",
    "applytojob.com", "recruitee.com", "bamboohr.com", "pinpointhq.com"
  ];
  // Subdomain/path labels that are never the employer's name.
  const NON_COMPANY_LABELS = new Set([
    "www", "jobs", "job", "jobboards", "boards", "board", "apply", "applications",
    "careers", "career", "remote", "work", "hire", "hiring", "recruiting",
    "recruit", "talent", "app", "secure", "my", "go", "grnh", "embed", "portal"
  ]);
  const PATH_SKIP_RE = /^(jobs?|careers?|embed|apply|o|p|positions?|openings?|opportunities|company|en|us|uk|gb)$/i;
  const TLD_SECOND_LEVEL = new Set(["co", "com", "org", "gov", "ac", "net", "edu"]);

  function inferCompanyFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      const labels = host.split(".");
      const segs = url.pathname.split("/").filter(Boolean);
      const clean = (s) => toTitleCase(decodeURIComponent(String(s || "")).replace(/[-_+]+/g, " ").trim());

      // 1) Known ATS host → employer is a company subdomain or the first
      //    meaningful path segment.
      const atsRoot = ATS_PATH_ROOTS.find((r) => host === r || host.endsWith("." + r));
      if (atsRoot) {
        // Old Greenhouse embed style: ?for=company
        if (host.endsWith("greenhouse.io")) {
          const forCo = url.searchParams.get("for");
          if (forCo) return clean(forCo);
        }
        const sub = labels[0] || "";
        const subIsPlatform = NON_COMPANY_LABELS.has(sub.replace(/[-_]/g, "")) || labels.length <= 2;
        if (!subIsPlatform) return clean(sub);            // acme.workable.com
        const seg = segs.find((s) => !PATH_SKIP_RE.test(s));
        if (seg) return clean(seg);                       // …/gitlab/jobs/123
      }

      // 2) Workday: {company}.wdN.myworkdayjobs.com
      if (host.endsWith("myworkdayjobs.com")) return clean(labels[0]);

      // 3) Generic host: use the subdomain, unless it's a non-company label
      //    (jobs., careers., job-boards.) — then use the registrable domain.
      const first = labels[0] || "";
      if (NON_COMPANY_LABELS.has(first.replace(/[-_]/g, ""))) {
        let idx = labels.length - 2;
        if (idx > 0 && TLD_SECOND_LEVEL.has(labels[idx])) idx -= 1; // skip .co.uk etc.
        return clean(labels[Math.max(0, idx)] || first);
      }
      return clean(first);
    } catch (error) {
      return "";
    }
  }

  // Detect a Greenhouse/Lever/Ashby posting and pull out the employer's board
  // token, so we can auto-grow the Discover company list from roles the user
  // actually tracks. Returns { platform, token } or null.
  function extractAtsCompany(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      const segs = url.pathname.split("/").filter(Boolean);
      const valid = (t) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(t || "");
      if (host.endsWith("greenhouse.io")) {
        const forCo = url.searchParams.get("for");
        const seg = segs.find((s) => !/^(embed|jobs?)$/i.test(s));
        const token = (seg || forCo || "").toLowerCase();
        return valid(token) ? { platform: "greenhouse", token } : null;
      }
      if (host.endsWith("lever.co")) {
        const token = (segs[0] || "").toLowerCase();
        return valid(token) ? { platform: "lever", token } : null;
      }
      if (host.endsWith("ashbyhq.com")) {
        const token = (segs[0] || "").toLowerCase();
        return valid(token) ? { platform: "ashby", token } : null;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  function extractDomain(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.hostname.replace(/^www\./, "").toLowerCase();
    } catch (error) {
      return "";
    }
  }

  function isLinkedInJobUrl(rawUrl) {
    const host = extractDomain(rawUrl);
    return host === "linkedin.com" || host === "www.linkedin.com";
  }

  function extractExternalJobId(rawUrl, explicitJobId) {
    if (explicitJobId) {
      return String(explicitJobId).trim();
    }

    if (!rawUrl) {
      return "";
    }

    try {
      const url = new URL(rawUrl);

      for (const key of JOB_ID_QUERY_KEYS) {
        const value = url.searchParams.get(key);
        if (value) {
          return String(value).trim();
        }
      }

      const pathMatch = url.pathname.match(/\/jobs\/view\/(\d+)/i)
        || url.pathname.match(/\/(?:jobs|job|position|posting|openings|careers)\/(\d{4,})/i);

      return pathMatch ? String(pathMatch[1]).trim() : "";
    } catch (error) {
      return "";
    }
  }

  function normalizeUrl(rawUrl, explicitJobId) {
    if (!rawUrl) {
      return "";
    }

    try {
      const url = new URL(rawUrl);
      url.hash = "";

      const externalJobId = extractExternalJobId(rawUrl, explicitJobId);
      if (isLinkedInJobUrl(rawUrl) && externalJobId) {
        return `https://www.linkedin.com/jobs/view/${encodeURIComponent(externalJobId)}/`;
      }

      const keptParams = [];
      SIGNIFICANT_QUERY_KEYS.forEach((key) => {
        const value = url.searchParams.get(key);
        if (value) {
          keptParams.push([key.toLowerCase(), value]);
        }
      });

      keptParams.sort((a, b) => a[0].localeCompare(b[0]));

      let pathname = url.pathname.replace(/\/+$/, "");
      if (!pathname) {
        pathname = "/";
      }

      const query = keptParams
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");

      return `${url.origin.toLowerCase()}${pathname}${query ? `?${query}` : ""}`;
    } catch (error) {
      return String(rawUrl).trim();
    }
  }

  function generateId() {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function todayString() {
    return new Date().toISOString().slice(0, 10);
  }

  // AI-generated cover letter cached per-job. We invalidate when any of the
  // inputs change (CV, job description, role, or company) via a hash so users
  // don't pay the generation cost twice for the same inputs — see fxHashInputs.
  function sanitizeAiCoverLetter(input) {
    if (!input || typeof input !== "object") return null;
    const text = String(input.text || "").slice(0, 8000);
    if (!text) return null;
    return {
      text,
      model: String(input.model || "").slice(0, 80),
      provider: String(input.provider || "").slice(0, 40),
      inputsHash: String(input.inputsHash || "").slice(0, 32),
      generatedAt: String(input.generatedAt || new Date().toISOString()).slice(0, 30)
    };
  }

  // Small deterministic hash (djb2 + hex). Not crypto-grade — we just need a
  // fingerprint so cache hits/misses are correct across runs on the same data.
  function fxHash(str) {
    let h = 5381;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(16);
  }

  function hashCoverLetterInputs(parts) {
    const p = parts || {};
    return fxHash([
      (p.cv || "").trim(),
      (p.jd || "").trim(),
      (p.role || "").trim(),
      (p.company || "").trim()
    ].join("\u0001"));
  }

  // AI-generated fit analysis cached per-job. Compares the active section's CV
  // against the job description and returns a 0–100 score + strengths/missing
  // keyword lists. Cached on the job so it syncs through Drive; invalidated
  // when CV or JD changes via the inputsHash fingerprint.
  function sanitizeAiFitAnalysis(input) {
    if (!input || typeof input !== "object") return null;
    const score = Number(input.score);
    if (!Number.isFinite(score)) return null;
    const clamped = Math.max(0, Math.min(100, Math.round(score)));
    const strList = (arr) => (Array.isArray(arr) ? arr : [])
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((s) => s.slice(0, 120));
    return {
      score: clamped,
      strengths: strList(input.strengths),
      missing: strList(input.missing),
      summary: String(input.summary || "").slice(0, 500),
      model: String(input.model || "").slice(0, 80),
      provider: String(input.provider || "").slice(0, 40),
      inputsHash: String(input.inputsHash || "").slice(0, 32),
      generatedAt: String(input.generatedAt || new Date().toISOString()).slice(0, 30)
    };
  }

  function hashFitInputs(parts) {
    const p = parts || {};
    return fxHash([
      (p.cv || "").trim(),
      (p.jd || "").trim()
    ].join(""));
  }

  // Profile-level AI settings (BYOK). Kept on the profile so it syncs through
  // Drive. The API key is sensitive — the webapp only sends it directly from
  // the browser to the model provider; we never proxy through any third party.
  const AI_PROVIDERS = ["none", "anthropic", "openai", "gemini", "deepseek", "on-device"];
  const AI_DEFAULT_MODEL = {
    anthropic: "claude-sonnet-4-5",
    openai: "gpt-4o-mini",
    gemini: "gemini-1.5-flash-latest",
    deepseek: "deepseek-v4-flash",
    "on-device": "",
    none: ""
  };

  function sanitizeAiSettings(input) {
    const src = input && typeof input === "object" ? input : {};
    const provider = AI_PROVIDERS.indexOf(String(src.provider || "")) >= 0
      ? src.provider
      : "none";
    let model = String(src.model || AI_DEFAULT_MODEL[provider] || "").slice(0, 80);
    if (provider === "deepseek" && (!model || model === "deepseek-chat")) {
      model = AI_DEFAULT_MODEL.deepseek;
    }
    return {
      provider,
      apiKey: String(src.apiKey || "").slice(0, 512),
      model
    };
  }

  function sanitizeInterviewPrep(input) {
    // Structured per-job interview prep. Keep fields flat so legacy records
    // without the field sanitize into safe empty strings on read.
    const src = input && typeof input === "object" ? input : {};
    const trim = (v, cap) => String(v || "").slice(0, cap).trim();
    const clamp = (v, cap) => String(v || "").slice(0, cap);
    return {
      nextRound: trim(src.nextRound, 120),
      scheduledAt: trim(src.scheduledAt, 30),   // ISO / datetime-local value
      interviewers: trim(src.interviewers, 500),
      questionsToAsk: clamp(src.questionsToAsk, 4000),
      starStories: clamp(src.starStories, 6000),
      notes: clamp(src.notes, 4000)
    };
  }

  // Per-job list of interview rounds, each with its own notes. Empty rounds are
  // dropped so blank rows don't persist. Capped to keep storage bounded.
  const INTERVIEWS_MAX = 12;
  function sanitizeInterviews(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map((it) => {
        if (!it || typeof it !== "object") return null;
        const label = String(it.label || "").slice(0, 120).trim();
        const date = String(it.date || "").slice(0, 30).trim();
        const notes = String(it.notes || "").slice(0, 4000);
        if (!label && !date && !notes.trim()) return null;
        return {
          id: String(it.id || ("iv_" + Math.random().toString(36).slice(2, 10))),
          label,
          date,
          notes
        };
      })
      .filter(Boolean)
      .slice(0, INTERVIEWS_MAX);
  }

  // Status timeline: every transition is recorded as `{ status, at }` so the
  // UI can render a stage history per job. Capped at 24 entries to bound
  // storage on jobs that get bumped many times. Order is chronological
  // (oldest first), which makes appending O(1) and rendering trivial.
  const STAGE_HISTORY_MAX = 24;

  function sanitizeStageHistory(input) {
    if (!Array.isArray(input)) return [];
    const valid = input
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const status = String(entry.status || "").trim();
        if (!STATUS_META[status]) return null;
        const at = String(entry.at || "").trim();
        if (!at) return null;
        const t = new Date(at).getTime();
        if (!Number.isFinite(t)) return null;
        return { status, at };
      })
      .filter(Boolean);
    // Keep most recent STAGE_HISTORY_MAX entries (drop oldest if we ever go over).
    if (valid.length > STAGE_HISTORY_MAX) {
      return valid.slice(valid.length - STAGE_HISTORY_MAX);
    }
    return valid;
  }

  // Seed history for legacy jobs (saved before stage tracking existed) so the
  // timeline UI isn't empty for records that have an obvious initial state.
  // Called from sanitizeJob — only fills when the input had no history at all.
  function seedLegacyStageHistory(input, status, when) {
    if (Array.isArray(input) && input.length > 0) return null;
    if (!STATUS_META[status]) return null;
    const at = String(when || "").trim();
    if (!at) return null;
    const t = new Date(at).getTime();
    if (!Number.isFinite(t)) return null;
    return [{ status, at }];
  }

  // Append a transition to a history list iff the new status differs from the
  // most recent entry. Returns the (possibly unchanged) list. Pure — caller
  // assigns the result back onto the job.
  function appendStageTransition(history, newStatus, when) {
    const list = Array.isArray(history) ? history.slice() : [];
    const last = list[list.length - 1];
    if (last && last.status === newStatus) return list;
    list.push({
      status: newStatus,
      at: when || new Date().toISOString()
    });
    if (list.length > STAGE_HISTORY_MAX) {
      return list.slice(list.length - STAGE_HISTORY_MAX);
    }
    return list;
  }

  function hasInterviewPrepContent(prep) {
    if (!prep) return false;
    return Boolean(
      prep.nextRound || prep.scheduledAt || prep.interviewers
      || prep.questionsToAsk || prep.starStories || prep.notes
    );
  }

  // Heuristic remote-eligibility check. Given a job and the user's home
  // country/region, decide whether it's remote and whether someone there could
  // likely take it. Conservative: only flags "restricted" on strong signals.
  // Returns { remote, eligibility: "eligible"|"restricted"|"unknown", reason }.
  const OPEN_REGION_RE = /\b(world\s?wide|anywhere|fully\s+remote\s+global|global(ly)?|emea|europe|european union|eu(\b|\s)|uk\b|united kingdom|england|britain|gmt|bst|cet)\b/i;
  function assessRemoteEligibility(job, homeCountry, candidateLocation) {
    job = job || {};
    const home = String(homeCountry || "").toLowerCase().trim();
    // Remotive jobs carry the accepted region in candidate_required_location;
    // fall back to the explicit arg for callers that pass it directly.
    const candidateLoc = candidateLocation || job.candidate_required_location || "";
    const reqLoc = String(candidateLoc).toLowerCase().trim();
    // Include the title — boards often encode the region lock there
    // ("… (US only)", "[Remote: LATAM Time Zones Only]") and nowhere else.
    const hay = [job.title, job.jobTitle, job.workMode, job.location, candidateLoc, job.description]
      .map((x) => String(x || "")).join("  ").toLowerCase();

    const remote = /\bremote\b|work from home|\bwfh\b|distributed team|remote-first/.test(hay);
    if (!remote) return { remote: false, eligibility: "unknown", reason: "" };

    // Remotive's candidate_required_location is the cleanest signal when present.
    if (reqLoc) {
      if (/worldwide|anywhere/.test(reqLoc)) return { remote: true, eligibility: "eligible", reason: "Open worldwide" };
      const homeTokens = ["uk", "united kingdom", "britain", "england", "europe", "emea", "eu"];
      if (home && reqLoc.indexOf(home.replace(/^.*,\s*/, "")) !== -1) return { remote: true, eligibility: "eligible", reason: "Your region is accepted" };
      if (homeTokens.some((t) => reqLoc.indexOf(t) !== -1)) return { remote: true, eligibility: "eligible", reason: "UK/Europe accepted" };
      // A specific location list that doesn't include the user.
      if (/usa|united states|u\.s\.|americas|canada|latam|apac|australia|india/.test(reqLoc)) {
        return { remote: true, eligibility: "restricted", reason: "Region: " + candidateLoc };
      }
    }

    const usOnly = /\b(u\.?s\.?a?|united states)[\s-]*(only|based|residents?|citizens?)\b|(only|must).{0,40}(united states|u\.?s\.?\b)|authori[sz]ed to work in the (us|united states)|\bus[\s-]?based\b/i.test(hay);
    const usStates = /\b(only|must|located|based|reside).{0,60}(alabama|alaska|arizona|texas|california|new york|washington|states listed)\b/i.test(hay);
    const homeMentioned = home && hay.indexOf(home.replace(/^.*,\s*/, "")) !== -1;
    if (homeMentioned || OPEN_REGION_RE.test(hay)) return { remote: true, eligibility: "eligible", reason: "Open to your region" };
    if (usOnly || usStates) return { remote: true, eligibility: "restricted", reason: "US-only role" };
    const otherLock = /\b(must be (located|based)|residents? of|eligible to work in|authori[sz]ed to work in|located within)\b/i.test(hay);
    if (otherLock) return { remote: true, eligibility: "restricted", reason: "Region-restricted — check details" };
    return { remote: true, eligibility: "unknown", reason: "Remote — region unclear" };
  }

  function sanitizeJob(input) {
    const now = new Date().toISOString();
    const url = input.url ? String(input.url).trim() : "";
    const company = String(input.company || inferCompanyFromUrl(url)).trim();
    const externalJobId = extractExternalJobId(url, input.externalJobId);
    const normalizedUrl = normalizeUrl(url, externalJobId);
    const sourceHost = extractDomain(url);
    const status = STATUS_META[input.status] ? input.status : "bookmarked";
    // Cached description — truncated so a huge listing can't blow storage quotas.
    const description = String(input.description || "").slice(0, 8000);
    const interviewPrep = sanitizeInterviewPrep(input.interviewPrep);
    const interviews = sanitizeInterviews(input.interviews);
    const aiCoverLetter = sanitizeAiCoverLetter(input.aiCoverLetter);
    const aiFitAnalysis = sanitizeAiFitAnalysis(input.aiFitAnalysis);
    let stageHistory = sanitizeStageHistory(input.stageHistory);
    // Backfill: legacy records saved before stage tracking get a seed entry
    // anchored to their createdAt timestamp so the timeline isn't empty for
    // pre-existing jobs after this update lands.
    if (stageHistory.length === 0) {
      const seed = seedLegacyStageHistory(
        input.stageHistory,
        STATUS_META[input.status] ? input.status : "bookmarked",
        input.createdAt || now
      );
      if (seed) stageHistory = seed;
    }
    // Tombstone: when non-null, the job is a "this was deleted" marker that
    // we keep around so the deletion propagates through Drive sync. We filter
    // these out of UI reads (getAllJobs) and purge them after 30 days.
    const deletedAt = input.deletedAt ? String(input.deletedAt) : null;

    const updatedAt = (input.updatedAt && !isNaN(new Date(input.updatedAt).getTime()))
      ? input.updatedAt
      : now;

    return {
      id: input.id || generateId(),
      jobTitle: String(input.jobTitle || input.title || "").trim(),
      company,
      location: String(input.location || "").trim(),
      workMode: String(input.workMode || "").trim(),
      jobType: String(input.jobType || "").trim(),
      status,
      salary: String(input.salary || "").trim(),
      dateApplied: String(input.dateApplied || "").trim(),
      notes: String(input.notes || "").trim(),
      description,
      sourceHost,
      titleFingerprint: normalizeText(input.jobTitle || input.title || ""),
      companyFingerprint: normalizeText(company),
      externalJobId,
      url,
      normalizedUrl,
      interviewPrep,
      interviews,
      aiCoverLetter,
      aiFitAnalysis,
      stageHistory,
      createdAt: input.createdAt || now,
      updatedAt,
      deletedAt
    };
  }

  const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  function purgeOldTombstones(jobs) {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    return jobs.filter((j) => {
      if (!j || !j.deletedAt) return true;
      const t = new Date(j.deletedAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }

  function mergeJobsByUpdatedAt(listA, listB) {
    // Per-id last-write-wins merge. Tombstones participate as normal records —
    // a delete on one device is just a write with deletedAt set, so whichever
    // side has the newer updatedAt propagates.
    const byId = new Map();
    const add = (job) => {
      if (!job || !job.id) return;
      const stampOf = (x) =>
        new Date(x.updatedAt || x.createdAt || 0).getTime() || 0;
      const existing = byId.get(job.id);
      if (!existing || stampOf(job) >= stampOf(existing)) {
        byId.set(job.id, job);
      }
    };
    (Array.isArray(listA) ? listA : []).forEach(add);
    (Array.isArray(listB) ? listB : []).forEach(add);
    return Array.from(byId.values());
  }

  function latestTimestamp(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return 0;
    }

    return jobs.reduce((latest, job) => {
      const current = new Date(job.updatedAt || job.createdAt || 0).getTime();
      return Math.max(latest, Number.isFinite(current) ? current : 0);
    }, 0);
  }

  async function readJobsFromArea(areaName) {
    try {
      const result = await storageGet(areaName, STORAGE_KEY);
      return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
    } catch (error) {
      return [];
    }
  }

  function stripHeavyFieldsFromJobs(jobs) {
    // Sync storage caps each item at 8 KB. Descriptions and notes can be huge,
    // so we keep full copies in local but drop them from the sync payload.
    return jobs.map((job) => {
      const clone = { ...job };
      if (clone.description) clone.description = "";
      return clone;
    });
  }

  async function writeJobsToAreas(jobs) {
    const sanitized = Array.isArray(jobs) ? jobs.map(sanitizeJob) : [];
    const payload = { [STORAGE_KEY]: sanitized };

    try {
      await storageSet(PRIMARY_STORAGE_AREA, { [STORAGE_KEY]: stripHeavyFieldsFromJobs(sanitized) });
    } catch (error) {
      // Keep local writes working even if sync is unavailable or over quota.
    }

    await storageSet(FALLBACK_STORAGE_AREA, payload);
    await recordSnapshot(sanitized).catch(() => undefined);
    // Prime the cache with the just-written sanitized list so the next read
    // skips the storage round-trip entirely. Without this, the storage event
    // we just fired triggers an onChanged invalidation which forces the
    // immediately-following getAllJobs to re-read both areas.
    jobsCache = sanitized;
    jobsCacheAt = Date.now();
    return sanitized;
  }

  async function readSnapshots() {
    try {
      const result = await storageGet(FALLBACK_STORAGE_AREA, SNAPSHOT_KEY);
      return Array.isArray(result[SNAPSHOT_KEY]) ? result[SNAPSHOT_KEY] : [];
    } catch (error) {
      return [];
    }
  }

  // Strip heavy AI / description / interview-prep fields from snapshot copies.
  // Snapshots are local restore points for "I deleted things, undo" — they
  // need to remember which jobs existed and their pipeline state. The heavy
  // AI cache is recoverable by re-running the model and the JD is recoverable
  // from Drive. Keeping it in every snapshot copy was the single biggest
  // contributor to the dashboard's runaway memory: with 100 jobs and 20 saved
  // snapshots, this alone was ~60 MB duplicated through storage events.
  function lightenJobsForSnapshot(jobs) {
    if (!Array.isArray(jobs)) return [];
    return jobs.map((j) => {
      if (!j) return j;
      const lite = Object.assign({}, j);
      delete lite.description;
      delete lite.aiCoverLetter;
      delete lite.aiFitAnalysis;
      delete lite.interviewPrep;
      delete lite.stageHistory;
      return lite;
    });
  }

  async function recordSnapshot(jobs) {
    const existing = await readSnapshots();
    const latest = existing[0];
    const lite = lightenJobsForSnapshot(jobs);
    const serialized = JSON.stringify(lite);

    if (latest && JSON.stringify(latest.jobs || []) === serialized) {
      return existing;
    }

    const snapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      takenAt: new Date().toISOString(),
      count: lite.length,
      jobs: lite
    };

    const next = [snapshot, ...existing].slice(0, MAX_SNAPSHOTS);
    try {
      await storageSet(FALLBACK_STORAGE_AREA, { [SNAPSHOT_KEY]: next });
    } catch (error) {
      // Snapshots are best-effort.
    }
    return next;
  }

  async function listSnapshots() {
    const snapshots = await readSnapshots();
    return snapshots.map((snapshot) => ({
      id: snapshot.id,
      takenAt: snapshot.takenAt,
      count: snapshot.count
    }));
  }

  async function restoreSnapshot(id) {
    const snapshots = await readSnapshots();
    const found = snapshots.find((snapshot) => snapshot.id === id);
    if (!found) {
      return [];
    }
    const restored = await writeJobsToAreas(found.jobs || []);
    return restored;
  }

  // In-memory cache for `ensureStorageConsistency`. Without this, getAllJobs
  // was hitting storage twice (sync + local) on every call — and getAllJobs
  // is invoked on every page navigation (CHECK_PAGE_STATUS), every dashboard
  // re-render, every popup open, every Drive sync tick. With a 1.5 s TTL,
  // bursts of activity coalesce into a single round-trip; the storage write
  // path invalidates the cache immediately so user actions stay coherent.
  let jobsCache = null;
  let jobsCacheAt = 0;
  const JOBS_CACHE_TTL_MS = 1500;

  function invalidateJobsCache() {
    jobsCache = null;
    jobsCacheAt = 0;
  }

  // Invalidate the cache whenever storage actually changes — covers Drive
  // sync pulls landing in the background, and writes from other contexts
  // (popup, content script) that happened outside this script's writeJobs.
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes && changes[STORAGE_KEY]) invalidateJobsCache();
      });
    } catch (_) { /* not in extension context */ }
  }

  async function ensureStorageConsistency() {
    if (jobsCache && Date.now() - jobsCacheAt < JOBS_CACHE_TTL_MS) {
      return jobsCache;
    }
    const syncJobsRaw = await readJobsFromArea(PRIMARY_STORAGE_AREA);
    const localJobsRaw = await readJobsFromArea(FALLBACK_STORAGE_AREA);
    // Drop tombstones older than 30 days here — they've had ample time to sync.
    const syncJobs = purgeOldTombstones(syncJobsRaw);
    const localJobs = purgeOldTombstones(localJobsRaw);

    let result;
    if (syncJobs.length === 0 && localJobs.length > 0) {
      try {
        await storageSet(PRIMARY_STORAGE_AREA, { [STORAGE_KEY]: localJobs });
      } catch (error) {
        // Sync might be disabled; local remains the source of truth for this device.
      }
      result = localJobs;
    } else if (syncJobs.length > 0 && localJobs.length === 0) {
      await storageSet(FALLBACK_STORAGE_AREA, { [STORAGE_KEY]: syncJobs });
      result = syncJobs;
    } else if (syncJobs.length > 0 && localJobs.length > 0) {
      const syncStamp = latestTimestamp(syncJobs);
      const localStamp = latestTimestamp(localJobs);
      let source = syncStamp >= localStamp ? syncJobs : localJobs;

      // When sync is the winner, its records were stripped of heavy fields
      // (description) to fit quota. Re-hydrate those from local by id so we
      // don't lose device-local description caches.
      if (source === syncJobs) {
        const localById = new Map(localJobs.map((j) => [j.id, j]));
        source = syncJobs.map((j) => {
          const local = localById.get(j.id);
          if (local && local.description && !j.description) {
            return { ...j, description: local.description };
          }
          return j;
        });
      }

      if (syncStamp !== localStamp) {
        await writeJobsToAreas(source);
      }

      result = source;
    } else {
      result = [];
    }

    jobsCache = result;
    jobsCacheAt = Date.now();
    return result;
  }

  async function getAllJobs() {
    const jobs = await ensureStorageConsistency();
    // Hide tombstones from every caller (UI, badge, duplicate-detection).
    // Sort by updatedAt desc, but break ties with id so the order is stable
    // across renders — without the secondary key, two jobs with identical
    // updatedAt could swap positions on every reload, causing the dashboard
    // to "shuffle" rows mid-click after a Drive sync.
    return jobs
      .filter((j) => !j.deletedAt)
      .sort((a, b) => {
        const diff = new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
        if (diff !== 0) return diff;
        return String(a.id || "").localeCompare(String(b.id || ""));
      });
  }

  async function getAllJobsIncludingTombstones() {
    return ensureStorageConsistency();
  }

  async function replaceAllJobs(jobs) {
    const sanitized = Array.isArray(jobs) ? jobs.map(sanitizeJob) : [];
    await writeJobsToAreas(sanitized);
    return sanitized;
  }

  function findMatchingJob(jobs, context) {
    const normalizedUrl = normalizeUrl(context.url || "", context.externalJobId);
    const normalizedTitle = normalizeText(context.title || context.jobTitle || "");
    const normalizedCompany = normalizeText(context.company || "");
    const sourceHost = extractDomain(context.url || "");
    const externalJobId = extractExternalJobId(context.url || "", context.externalJobId);

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return null;
    }

    if (sourceHost && externalJobId) {
      const byExternalId = jobs.find((job) => {
        return job.sourceHost === sourceHost && job.externalJobId && job.externalJobId === externalJobId;
      });
      if (byExternalId) {
        return byExternalId;
      }
    }

    if (normalizedUrl) {
      const byUrl = jobs.find((job) => job.normalizedUrl && job.normalizedUrl === normalizedUrl);
      if (byUrl) {
        return byUrl;
      }
    }

    if (normalizedCompany && normalizedTitle) {
      return jobs.find((job) => {
        return job.companyFingerprint === normalizedCompany && job.titleFingerprint === normalizedTitle;
      }) || null;
    }

    return null;
  }

  async function upsertJob(input) {
    // Read the full list (including tombstones) so that saving a job whose id
    // matches a tombstone resurrects it instead of creating a duplicate.
    const jobs = await getAllJobsIncludingTombstones();
    const prepared = sanitizeJob(input);
    // A fresh upsert implicitly clears any prior deletedAt on the same id.
    prepared.deletedAt = null;
    const existingIndex = jobs.findIndex((job) => job.id === prepared.id);
    let savedRecord = prepared;

    if (existingIndex >= 0) {
      const merged = {
        ...jobs[existingIndex],
        ...prepared,
        createdAt: jobs[existingIndex].createdAt || prepared.createdAt
      };
      // Status timeline: append a transition entry whenever the new save
      // changes status. Carries over the existing history so we keep the
      // full trail (bookmarked → applying → applied → interviewing → …).
      merged.stageHistory = appendStageTransition(
        jobs[existingIndex].stageHistory || prepared.stageHistory,
        merged.status,
        merged.updatedAt
      );
      jobs[existingIndex] = merged;
      savedRecord = merged;
    } else {
      // Duplicate detection only considers live records — we don't want a
      // tombstone matching by URL/title to silently resurrect on a new save.
      const liveJobs = jobs.filter((j) => !j.deletedAt);
      const duplicate = findMatchingJob(liveJobs, {
        url: prepared.url,
        title: prepared.jobTitle,
        company: prepared.company,
        externalJobId: prepared.externalJobId
      });

      if (duplicate) {
        const duplicateIndex = jobs.findIndex((job) => job.id === duplicate.id);
        const merged = {
          ...jobs[duplicateIndex],
          ...prepared,
          id: jobs[duplicateIndex].id,
          createdAt: jobs[duplicateIndex].createdAt || prepared.createdAt
        };
        merged.stageHistory = appendStageTransition(
          jobs[duplicateIndex].stageHistory || prepared.stageHistory,
          merged.status,
          merged.updatedAt
        );
        jobs[duplicateIndex] = merged;
        savedRecord = merged;
      } else {
        // Brand-new record: seed the history with the initial status.
        prepared.stageHistory = appendStageTransition([], prepared.status, prepared.createdAt);
        jobs.unshift(prepared);
        savedRecord = prepared;
      }
    }

    await writeJobsToAreas(jobs);
    return savedRecord;
  }

  async function deleteJob(id) {
    // Soft delete: keep the record as a tombstone so the deletion propagates
    // through Drive sync to other devices. getAllJobs filters tombstones out.
    const all = await getAllJobsIncludingTombstones();
    const now = new Date().toISOString();
    const next = all.map((job) => {
      if (job.id !== id) return job;
      return Object.assign({}, job, {
        deletedAt: now,
        updatedAt: now
      });
    });
    await writeJobsToAreas(next);
    return next.filter((j) => !j.deletedAt);
  }

  async function clearAllJobs() {
    try {
      await storageRemove(PRIMARY_STORAGE_AREA, STORAGE_KEY);
    } catch (error) {
      // Ignore sync failures and still clear local fallback.
    }
    await storageRemove(FALLBACK_STORAGE_AREA, STORAGE_KEY);
  }

  function countByStatus(jobs) {
    return STATUS_ORDER.reduce((accumulator, status) => {
      accumulator[status] = jobs.filter((job) => job.status === status).length;
      return accumulator;
    }, {});
  }

  function statusLabel(status) {
    return STATUS_META[status] ? STATUS_META[status].label : "Unknown";
  }

  function statusBadge(status) {
    return STATUS_META[status] ? STATUS_META[status].badge : "OK";
  }

  function statusColor(status) {
    return STATUS_META[status] ? STATUS_META[status].color : "#0f766e";
  }

  function sanitizeCustomAnswers(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const question = cleanCustomAnswerQuestion(entry.question);
        const answer = String(entry.answer || "").trim();
        if (!question || !answer) return null;
        if (isNoisyCustomAnswerQuestion(question, answer)) return null;
        // `source` distinguishes manually-typed answers from those auto-captured
        // during autofill — used by the saved-answers UI to flag and let the
        // user confirm/edit captured rows. `capturedAt` is ISO when source=captured.
        const source = entry.source === "captured" ? "captured" : "manual";
        const capturedAt = source === "captured"
          ? String(entry.capturedAt || new Date().toISOString()).slice(0, 30)
          : "";
        return {
          id: String(entry.id || ("qa_" + Math.random().toString(36).slice(2, 10))),
          question: question.slice(0, 200),
          answer: answer.slice(0, 2000),
          source,
          capturedAt
        };
      })
      .filter(Boolean);
  }

  function sanitizeResumeFile(input) {
    if (!input || typeof input !== "object") return null;
    const name = String(input.name || "").trim();
    const type = String(input.type || "").trim();
    const dataUrl = String(input.dataUrl || "");
    const size = Number(input.size) || 0;
    if (!name || !dataUrl || !dataUrl.startsWith("data:")) return null;
    return { name, type, size, dataUrl };
  }

  function sanitizeSection(input, fallbackId) {
    const source = input && typeof input === "object" ? input : {};
    const section = {};
    const rawId = String(source.id || fallbackId || "").trim();
    section.id = rawId || ("sec_" + Math.random().toString(36).slice(2, 10));
    section.name = String(source.name || "Section").trim() || "Section";
    PROFILE_SECTION_FIELDS.forEach((field) => {
      section[field] = source[field] ? String(source[field]).trim() : "";
    });
    section.customAnswers = sanitizeCustomAnswers(source.customAnswers);
    section.resumeFile = sanitizeResumeFile(source.resumeFile);
    return section;
  }

  function makeEmptySection(preset) {
    return sanitizeSection({
      id: preset && preset.id,
      name: preset && preset.name
    });
  }

  function migrateLegacyProfileToSections(source) {
    const legacyHasSectionData = PROFILE_SECTION_FIELDS.some((f) => source[f]) ||
      (Array.isArray(source.customAnswers) && source.customAnswers.length > 0);

    const defaults = DEFAULT_SECTIONS.map(makeEmptySection);

    if (!legacyHasSectionData) return defaults;

    const migrated = sanitizeSection({
      id: "full-time",
      name: "Full-time",
      customAnswers: source.customAnswers,
      ...PROFILE_SECTION_FIELDS.reduce((acc, f) => {
        acc[f] = source[f];
        return acc;
      }, {})
    });
    return [migrated, makeEmptySection(DEFAULT_SECTIONS[1]), makeEmptySection(DEFAULT_SECTIONS[2])];
  }

  function sanitizeProfile(input) {
    const source = input && typeof input === "object" ? input : {};
    const profile = {};
    PROFILE_COMMON_FIELDS.forEach((field) => {
      profile[field] = source[field] ? String(source[field]).trim() : "";
    });
    // Tidy name casing on every read/write so autofill never types ALL-CAPS or
    // all-lowercase names into a form (mixed-case names are preserved).
    profile.firstName = normalizeNameCase(profile.firstName);
    profile.lastName = normalizeNameCase(profile.lastName);
    if (profile.fullName) {
      profile.fullName = normalizeNameCase(profile.fullName);
    } else if (profile.firstName || profile.lastName) {
      profile.fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
    }

    let sections = Array.isArray(source.sections) && source.sections.length
      ? source.sections.map((s) => sanitizeSection(s))
      : migrateLegacyProfileToSections(source);

    if (!sections.length) sections = DEFAULT_SECTIONS.map(makeEmptySection);
    profile.sections = sections;

    const requestedActive = String(source.activeSectionId || "").trim();
    profile.activeSectionId = sections.find((s) => s.id === requestedActive)
      ? requestedActive
      : sections[0].id;

    profile.ai = sanitizeAiSettings(source.ai);

    return profile;
  }

  function findActiveSection(profile) {
    if (!profile || !Array.isArray(profile.sections) || profile.sections.length === 0) return null;
    return profile.sections.find((s) => s.id === profile.activeSectionId) || profile.sections[0];
  }

  function renderCoverLetterTemplate(template, context) {
    if (!template) return "";
    const ctx = context || {};
    return String(template)
      .replace(/\{company\}/gi, ctx.company || "")
      .replace(/\{(jobTitle|role|position)\}/gi, ctx.jobTitle || "")
      .replace(/\{location\}/gi, ctx.location || "")
      .replace(/\{salary\}/gi, ctx.salary || "");
  }

  function stripBinariesFromProfile(profile) {
    const clone = JSON.parse(JSON.stringify(profile));
    if (Array.isArray(clone.sections)) {
      clone.sections.forEach((s) => { if (s && s.resumeFile) s.resumeFile = null; });
    }
    return clone;
  }

  async function getProfile() {
    const local = await storageGet(FALLBACK_STORAGE_AREA, PROFILE_KEY).catch(() => ({}));
    if (local && local[PROFILE_KEY]) return sanitizeProfile(local[PROFILE_KEY]);
    const sync = await storageGet(PRIMARY_STORAGE_AREA, PROFILE_KEY).catch(() => ({}));
    return sanitizeProfile(sync && sync[PROFILE_KEY]);
  }

  async function saveProfile(input) {
    const profile = sanitizeProfile(input);
    await storageSet(FALLBACK_STORAGE_AREA, { [PROFILE_KEY]: profile });
    try {
      await storageSet(PRIMARY_STORAGE_AREA, { [PROFILE_KEY]: stripBinariesFromProfile(profile) });
    } catch (_) { /* sync may be disabled or over quota */ }
    return profile;
  }

  function descriptorKeyFor(descriptor) {
    return String(descriptor || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);
  }

  async function getAutofillMappings() {
    const res = await storageGet(FALLBACK_STORAGE_AREA, AUTOFILL_MAPPINGS_KEY).catch(() => ({}));
    const all = res && res[AUTOFILL_MAPPINGS_KEY];
    return all && typeof all === "object" ? all : {};
  }

  async function getHostAutofillMappings(host) {
    if (!host) return {};
    const all = await getAutofillMappings();
    const entries = all[host] && typeof all[host] === "object" ? all[host] : {};
    // Flatten to { descriptorKey: profileField }
    const flat = {};
    Object.keys(entries).forEach((k) => {
      const entry = entries[k];
      if (entry && entry.profileField) flat[k] = entry.profileField;
    });
    return flat;
  }

  async function saveAutofillMapping(host, descriptor, profileField) {
    if (!host || !descriptor || !profileField) return;
    const descKey = descriptorKeyFor(descriptor);
    if (!descKey) return;

    const all = await getAutofillMappings();
    const forHost = all[host] && typeof all[host] === "object" ? all[host] : {};

    forHost[descKey] = {
      descriptor: String(descriptor).slice(0, 200),
      profileField: String(profileField).slice(0, 64),
      learnedAt: Date.now()
    };

    // Cap host entries to avoid unbounded growth — drop oldest.
    const keys = Object.keys(forHost);
    if (keys.length > MAX_MAPPINGS_PER_HOST) {
      keys
        .map((k) => ({ k, t: forHost[k].learnedAt || 0 }))
        .sort((a, b) => a.t - b.t)
        .slice(0, keys.length - MAX_MAPPINGS_PER_HOST)
        .forEach(({ k }) => { delete forHost[k]; });
    }

    all[host] = forHost;
    try {
      await storageSet(FALLBACK_STORAGE_AREA, { [AUTOFILL_MAPPINGS_KEY]: all });
    } catch (_) { /* ignore quota */ }
  }

  async function clearAutofillMappings() {
    await storageSet(FALLBACK_STORAGE_AREA, { [AUTOFILL_MAPPINGS_KEY]: {} });
  }

  // Normalize a form question for dedupe: drop trailing required markers, punctuation.
  function normalizeCustomAnswerQuestion(q) {
    return cleanCustomAnswerQuestion(q)
      .replace(/\*+\s*$/, "")
      .replace(/\s*\(?\s*required\s*\)?\s*$/i, "")
      .replace(/[\s:：?？]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // Remove a block of words that is immediately repeated, which happens when a
  // field's label, aria-label, name and option text all carry the same string:
  //   "website website website"               -> "website"
  //   "united kingdom united kingdom are you"  -> "united kingdom are you"
  function collapseAdjacentDuplicateBlocks(text) {
    let words = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 120) return words.join(" ");
    const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
    let guard = 0;
    let changed = true;
    while (changed && guard++ < 200) {
      changed = false;
      for (let i = 0; i < words.length && !changed; i++) {
        const maxL = Math.floor((words.length - i) / 2);
        for (let L = maxL; L >= 1; L--) {
          let dup = true;
          for (let k = 0; k < L; k++) {
            if (!eq(words[i + k], words[i + L + k])) { dup = false; break; }
          }
          if (dup) { words.splice(i + L, L); changed = true; break; }
        }
      }
    }
    return words.join(" ");
  }

  // Forms often expose the question twice (visible label + accessibility name),
  // sometimes with the second copy truncated: "Question? Questio". If the text
  // after the first "?" is just the start of the question again, drop it.
  function dropQuestionEcho(text) {
    const t = String(text || "").trim();
    const qIdx = t.indexOf("?");
    if (qIdx <= 0 || qIdx >= t.length - 1) return t;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const head = t.slice(0, qIdx + 1).trim();
    const tailN = norm(t.slice(qIdx + 1));
    if (tailN.length >= 6 && norm(head).startsWith(tailN.slice(0, 60))) return head;
    return t;
  }

  function cleanCustomAnswerQuestion(q) {
    let out = String(q || "")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, " ")
      .replace(/[0-9a-f]{5,}-[0-9a-f-]{8,}/ig, " ")
      .replace(/\b[0-9a-f]{20,}\b/ig, " ")
      .replace(/\b[a-z0-9]{8,}_[a-z0-9_-]{8,}\b/ig, " ")
      .replace(/_?systemfield_?/ig, " ")
      // Strip framework/DOM widget tokens: "__ -labeled-radio-0",
      // "-labeled-checkbox-3", "react-select-2-input", "radio-4".
      .replace(/[_|*\s-]*labeled-(?:radio|checkbox|select|input|listbox|combobox|textbox)-\d+/ig, " ")
      .replace(/\breact-select-[a-z0-9-]+/ig, " ")
      .replace(/\b(?:radio|checkbox|listbox|combobox|textbox)-\d+\b/ig, " ")
      .replace(/\btype here(?:\.\.\.)?\b/ig, " ")
      .replace(/\.{2,}/g, " ")
      .replace(/[_|]{2,}/g, " ")
      .replace(/\b(?:input|field|control|button|select)\b(?:\s+\1\b)+/ig, "$1")
      .replace(/\s+/g, " ")
      .trim();
    out = collapseAdjacentDuplicateBlocks(out);
    out = dropQuestionEcho(out);
    out = out
      .replace(/\s+/g, " ")
      .replace(/^[\s:：?？.,;|_*-]+|[\s:：?？.,;|_*-]+$/g, "")
      .trim();
    // Tidy the display: capitalize the first letter (matching is done on a
    // lowercased copy elsewhere, so case here is purely cosmetic).
    return out ? out.charAt(0).toUpperCase() + out.slice(1) : out;
  }

  function isNoisyCustomAnswerQuestion(question, answer) {
    const q = String(question || "").trim();
    const a = String(answer || "").trim();
    if (!q || q.length < 4) return true;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(q)) return true;
    if (/_?systemfield_?|type here/i.test(q)) return true;
    if (/^(name|full name|first name|last name|email|phone|telephone|mobile|city|country|location)$/i.test(q)) return true;
    if (/^(name\s*)+$/i.test(q)) return true;
    if (normalizeQuestionForNoise(q) && normalizeQuestionForNoise(q) === normalizeQuestionForNoise(a)) return true;
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const usefulShortQuestion = /\b(salary|compensation|pay|ote|sponsor|sponsorship|visa|permit|authori[sz]ation|eligible|work|start|notice|availability|remote|hybrid|relocat|commut|language|country|location)\b/i.test(q);
    if (words.length <= 2 && !/[?]/.test(q) && q.length < 24 && !usefulShortQuestion) return true;
    return false;
  }

  function normalizeQuestionForNoise(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Batched form of captureCustomAnswer: takes an array of {question, answer}
  // and persists them in a single profile read + write. The single-message
  // background handler accumulates 700 ms of captures and calls this once
  // per batch — ten form fields filled in succession became one storage
  // round-trip instead of ten.
  async function captureCustomAnswers(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { added: 0 };

    const profile = await getProfile();
    const section = findActiveSection(profile);
    if (!section) return { added: 0, reason: "no-section" };

    const existing = Array.isArray(section.customAnswers) ? section.customAnswers : [];
    // Index existing answers by normalized question so we can both dedupe new
    // captures and update an existing answer when the caller passes `update`
    // (i.e. the user edited the answer on a form and wants it remembered).
    const byNorm = new Map();
    existing.forEach((e) => { byNorm.set(normalizeCustomAnswerQuestion(e.question), e); });
    const additions = [];
    let updated = 0;
    for (const item of list) {
      const q = cleanCustomAnswerQuestion((item && item.question) || "");
      const a = String((item && item.answer) || "").trim();
      if (!q || !a) continue;
      if (q.length < 4 || a.length > 2000) continue;
      if (isNoisyCustomAnswerQuestion(q, a)) continue;
      const norm = normalizeCustomAnswerQuestion(q);
      const match = byNorm.get(norm);
      if (match) {
        // Overwrite the stored answer only when explicitly asked to, and only
        // if it actually changed — so re-running autofill never churns writes.
        if (item && item.update && String(match.answer || "").trim() !== a) {
          match.answer = a.slice(0, 2000);
          match.capturedAt = new Date().toISOString();
          updated += 1;
        }
        continue;
      }
      const entry = {
        id: "qa_" + Math.random().toString(36).slice(2, 10),
        question: q.slice(0, 200),
        answer: a.slice(0, 2000),
        source: "captured",
        capturedAt: new Date().toISOString()
      };
      byNorm.set(norm, entry);
      additions.push(entry);
    }

    if (!additions.length && !updated) return { added: 0, reason: "all-duplicates" };

    section.customAnswers = sanitizeCustomAnswers(existing.concat(additions));
    await saveProfile(profile);
    return { added: additions.length, updated };
  }

  // Append a captured question→answer pair to the active section's customAnswers.
  // De-dupes against existing answers (case-insensitive, punctuation-insensitive).
  // Returns { added: true|false, reason? } so callers can show feedback.
  async function captureCustomAnswer(question, answer) {
    const q = cleanCustomAnswerQuestion(question);
    const a = String(answer || "").trim();
    if (!q || !a) return { added: false, reason: "empty" };
    if (q.length < 4) return { added: false, reason: "too-short" };
    if (isNoisyCustomAnswerQuestion(q, a)) return { added: false, reason: "noisy-question" };
    // Sanity cap so we don't persist essay answers or runaway HTML payloads.
    if (a.length > 2000) return { added: false, reason: "too-long" };

    const profile = await getProfile();
    const section = findActiveSection(profile);
    if (!section) return { added: false, reason: "no-section" };

    const norm = normalizeCustomAnswerQuestion(q);
    const existing = Array.isArray(section.customAnswers) ? section.customAnswers : [];
    const dup = existing.some((entry) => normalizeCustomAnswerQuestion(entry.question) === norm);
    if (dup) return { added: false, reason: "duplicate" };

    section.customAnswers = sanitizeCustomAnswers(existing.concat([{
      id: "qa_" + Math.random().toString(36).slice(2, 10),
      question: q.slice(0, 200),
      answer: a.slice(0, 2000),
      source: "captured",
      capturedAt: new Date().toISOString()
    }]));

    await saveProfile(profile);
    return { added: true };
  }

  async function countAutofillMappings() {
    const all = await getAutofillMappings();
    let total = 0;
    let hosts = 0;
    Object.keys(all).forEach((h) => {
      const n = Object.keys(all[h] || {}).length;
      if (n > 0) {
        hosts += 1;
        total += n;
      }
    });
    return { total, hosts };
  }

  async function getAccountProfile() {
    const syncJobs = await readJobsFromArea(PRIMARY_STORAGE_AREA);
    const localJobs = await readJobsFromArea(FALLBACK_STORAGE_AREA);

    return new Promise((resolve) => {
      const finish = (email) => {
        resolve({
          email: email || "",
          isSignedIn: Boolean(email),
          storageArea: PRIMARY_STORAGE_AREA,
          syncedRecords: syncJobs.length,
          localRecords: localJobs.length
        });
      };

      if (!globalScope.chrome || !globalScope.chrome.identity || !globalScope.chrome.identity.getProfileUserInfo) {
        finish("");
        return;
      }

      globalScope.chrome.identity.getProfileUserInfo((profile) => {
        const error = globalScope.chrome.runtime ? globalScope.chrome.runtime.lastError : null;
        if (error) {
          finish("");
          return;
        }

        finish(profile && profile.email ? profile.email : "");
      });
    });
  }

  globalScope.JobCRMData = {
    // Internal escape hatch so callers (e.g. dashboard after a Drive pull)
    // can force the next read to bypass the in-memory TTL cache.
    _invalidateJobsCache: invalidateJobsCache,
    STORAGE_KEY,
    SNAPSHOT_KEY,
    PROFILE_KEY,
    AUTOFILL_MAPPINGS_KEY,
    PROFILE_FIELDS,
    PROFILE_COMMON_FIELDS,
    PROFILE_SECTION_FIELDS,
    STATUS_ORDER,
    STATUS_META,
    PRIMARY_STORAGE_AREA,
    clearAllJobs,
    clearAutofillMappings,
    countAutofillMappings,
    countByStatus,
    hasInterviewPrepContent,
    assessRemoteEligibility,
    hashCoverLetterInputs,
    AI_PROVIDERS,
    AI_DEFAULT_MODEL,
    sanitizeAiSettings,
    sanitizeAiCoverLetter,
    sanitizeAiFitAnalysis,
    hashFitInputs,
    deleteJob,
    descriptorKeyFor,
    extractDomain,
    extractExternalJobId,
    findActiveSection,
    findMatchingJob,
    getAccountProfile,
    getAllJobs,
    getAllJobsIncludingTombstones,
    getAutofillMappings,
    getHostAutofillMappings,
    getProfile,
    inferCompanyFromUrl,
    extractAtsCompany,
    listSnapshots,
    mergeJobsByUpdatedAt,
    normalizeText,
    normalizeUrl,
    renderCoverLetterTemplate,
    replaceAllJobs,
    restoreSnapshot,
    sanitizeCustomAnswers,
    sanitizeStageHistory,
    appendStageTransition,
    captureCustomAnswer,
    captureCustomAnswers,
    normalizeCustomAnswerQuestion,
    sanitizeJob,
    sanitizeProfile,
    normalizeNameCase,
    saveAutofillMapping,
    saveProfile,
    statusBadge,
    statusColor,
    statusLabel,
    todayString,
    upsertJob
  };
})(typeof self !== "undefined" ? self : window);
