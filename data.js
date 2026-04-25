(function initJobCRMData(globalScope) {
  const STORAGE_KEY = "teal_job_crm_records_v1";
  const SNAPSHOT_KEY = "jobtrail_snapshots_v1";
  const PROFILE_KEY = "jobtrail_profile_v1";
  const AUTOFILL_MAPPINGS_KEY = "jobtrail_autofill_mappings_v1";
  const MAX_SNAPSHOTS = 20;
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

  function inferCompanyFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^www\./, "");
      const first = host.split(".")[0] || "";
      return toTitleCase(first.replace(/[-_]+/g, " "));
    } catch (error) {
      return "";
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
    deepseek: "deepseek-chat",
    "on-device": "",
    none: ""
  };

  function sanitizeAiSettings(input) {
    const src = input && typeof input === "object" ? input : {};
    const provider = AI_PROVIDERS.indexOf(String(src.provider || "")) >= 0
      ? src.provider
      : "none";
    return {
      provider,
      apiKey: String(src.apiKey || "").slice(0, 512),
      model: String(src.model || AI_DEFAULT_MODEL[provider] || "").slice(0, 80)
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

  function hasInterviewPrepContent(prep) {
    if (!prep) return false;
    return Boolean(
      prep.nextRound || prep.scheduledAt || prep.interviewers
      || prep.questionsToAsk || prep.starStories || prep.notes
    );
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
    const aiCoverLetter = sanitizeAiCoverLetter(input.aiCoverLetter);
    const aiFitAnalysis = sanitizeAiFitAnalysis(input.aiFitAnalysis);
    // Tombstone: when non-null, the job is a "this was deleted" marker that
    // we keep around so the deletion propagates through Drive sync. We filter
    // these out of UI reads (getAllJobs) and purge them after 30 days.
    const deletedAt = input.deletedAt ? String(input.deletedAt) : null;

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
      aiCoverLetter,
      aiFitAnalysis,
      createdAt: input.createdAt || now,
      updatedAt: now,
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

  async function recordSnapshot(jobs) {
    const existing = await readSnapshots();
    const latest = existing[0];
    const serialized = JSON.stringify(jobs || []);

    if (latest && JSON.stringify(latest.jobs || []) === serialized) {
      return existing;
    }

    const snapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      takenAt: new Date().toISOString(),
      count: Array.isArray(jobs) ? jobs.length : 0,
      jobs: Array.isArray(jobs) ? jobs : []
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

  async function ensureStorageConsistency() {
    const syncJobsRaw = await readJobsFromArea(PRIMARY_STORAGE_AREA);
    const localJobsRaw = await readJobsFromArea(FALLBACK_STORAGE_AREA);
    // Drop tombstones older than 30 days here — they've had ample time to sync.
    const syncJobs = purgeOldTombstones(syncJobsRaw);
    const localJobs = purgeOldTombstones(localJobsRaw);

    if (syncJobs.length === 0 && localJobs.length > 0) {
      try {
        await storageSet(PRIMARY_STORAGE_AREA, { [STORAGE_KEY]: localJobs });
      } catch (error) {
        // Sync might be disabled; local remains the source of truth for this device.
      }
      return localJobs;
    }

    if (syncJobs.length > 0 && localJobs.length === 0) {
      await storageSet(FALLBACK_STORAGE_AREA, { [STORAGE_KEY]: syncJobs });
      return syncJobs;
    }

    if (syncJobs.length > 0 && localJobs.length > 0) {
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

      return source;
    }

    return [];
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
        jobs[duplicateIndex] = merged;
        savedRecord = merged;
      } else {
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
        const question = String(entry.question || "").trim();
        const answer = String(entry.answer || "").trim();
        if (!question || !answer) return null;
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
    if (!profile.fullName && (profile.firstName || profile.lastName)) {
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
    return String(q || "")
      .replace(/\*+\s*$/, "")
      .replace(/\s*\(?\s*required\s*\)?\s*$/i, "")
      .replace(/[\s:：?？]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // Append a captured question→answer pair to the active section's customAnswers.
  // De-dupes against existing answers (case-insensitive, punctuation-insensitive).
  // Returns { added: true|false, reason? } so callers can show feedback.
  async function captureCustomAnswer(question, answer) {
    const q = String(question || "").trim();
    const a = String(answer || "").trim();
    if (!q || !a) return { added: false, reason: "empty" };
    if (q.length < 4) return { added: false, reason: "too-short" };
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
    listSnapshots,
    mergeJobsByUpdatedAt,
    normalizeText,
    normalizeUrl,
    renderCoverLetterTemplate,
    replaceAllJobs,
    restoreSnapshot,
    sanitizeCustomAnswers,
    captureCustomAnswer,
    normalizeCustomAnswerQuestion,
    sanitizeJob,
    sanitizeProfile,
    saveAutofillMapping,
    saveProfile,
    statusBadge,
    statusColor,
    statusLabel,
    todayString,
    upsertJob
  };
})(typeof self !== "undefined" ? self : window);
