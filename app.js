(function initJobTrailWebapp() {
  "use strict";

  const data = window.JobCRMData;
  const drive = window.JobTrailDrive;
  const driveAuth = window.JobTrailDriveAuth || null;
  const config = window.JOBTRAIL_CONFIG || {};
  const runtime = window.JOBTRAIL_RUNTIME || {};
  // Full Drive scope is intentional here: the webapp and Chrome extension use
  // different OAuth client IDs, so `drive.file` can strand them on separate
  // app-private copies of JobTrail/jobtrail-data.json.
  // Full Drive scope is required: the extension and the webapp are separate
  // OAuth clients that must read/write the SAME jobtrail-data.json file. Under
  // drive.file each client only sees files IT created, which breaks that shared
  // sync — so we keep auth/drive (the "unverified app" warning is the tradeoff).
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
  const isExtensionRuntime = Boolean(runtime.isExtension && driveAuth);

  // In-memory dataset; Drive is the source of truth on disk.
  let state = {
    jobs: [],
    profile: null,
    autofillMappings: {},
    loaded: false,
    demo: false
  };

  // OAuth token state
  let tokenClient = null;
  let currentToken = null;
  let tokenExpiry = 0;
  let pendingTokenResolve = null;
  // Whether the pending request was interactive (affects whether we show a
  // failure toast — silent refreshes on page load shouldn't nag the user).
  let lastRequestInteractive = false;

  const SIGNED_IN_FLAG = "jobtrail_was_signed_in_v1";
  // We cache the access token + expiry in localStorage so refreshes within
  // the token TTL don't need any round-trip to Google.
  // GIS silent-refresh fails too often (third-party cookies / FedCM quirks)
  // to be the sole persistence mechanism. On expiry we fall back to silent
  // refresh, then to interactive sign-in.
  const TOKEN_CACHE_KEY = "jobtrail_oauth_token_v2";

  function readCachedToken() {
    try {
      const raw = localStorage.getItem(TOKEN_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.token !== "string" || !parsed.token) return null;
      if (typeof parsed.expiry !== "number" || Date.now() >= parsed.expiry) return null;
      if (parsed.scope !== DRIVE_SCOPE) return null;
      return parsed;
    } catch (_) { return null; }
  }
  function writeCachedToken(token, expiry) {
    try { localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ token, expiry, scope: DRIVE_SCOPE })); } catch (_) {}
  }
  function clearCachedToken() {
    try { localStorage.removeItem(TOKEN_CACHE_KEY); } catch (_) {}
  }

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const signInBtn = $("signin-button");
  const signOutBtn = $("signout-button");
  const refreshBtn = $("refresh-button");
  const syncPill = $("sync-pill");
  const exportBtn = $("export-button");
  const importBtn = $("import-button");
  const importInput = $("import-input");
  const installBtn = $("install-button");
  const profileBtn = $("profile-button");
  const signedOutCard = $("signed-out-card");
  const demoBanner = $("demo-banner");
  const statsRow = $("stats-row");
  const viewTabs = $("view-tabs");
  const funnelSection = $("funnel-section");
  const jobsSection = $("jobs-section");
  const jobsEmpty = $("jobs-empty");
  const jobsTbody = $("jobs-tbody");
  const jobsSearch = $("jobs-search");
  const jobsFilterStatus = $("jobs-filter-status");
  const jobTypeTabs = $("job-type-tabs");
  const addJobBtn = $("add-job-button");
  const jobModal = $("job-modal");
  const jobForm = $("job-form");
  const jobModalTitle = $("job-modal-title");
  const jobDeleteBtn = $("job-delete-button");
  const toastEl = $("toast");
  const configWarn = $("config-warn");

  // Which top-level view is visible: "pipeline" (jobs table) or "funnel".
  let currentView = "pipeline";

  // ---------- Utilities ----------

  function setSync(state, label) {
    syncPill.textContent = label;
    syncPill.classList.toggle("is-signed-in", state === "signed-in");
    syncPill.classList.toggle("is-syncing", state === "syncing");
  }

  // Track the last successful Drive read/write so the pill can show freshness
  // ("Synced · 2m ago") even though background pulls are silent.
  let lastSyncedAt = 0;
  function syncAgoLabel() {
    if (!lastSyncedAt) return "";
    const s = Math.floor((Date.now() - lastSyncedAt) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }
  function updateSyncedLabel() {
    // Only refine the steady "Synced" state — never override "Syncing…" etc.
    if (!syncPill.classList.contains("is-signed-in") || syncPill.classList.contains("is-syncing")) return;
    const ago = syncAgoLabel();
    syncPill.textContent = ago ? "Synced · " + ago : "Synced";
  }
  function markSynced() {
    lastSyncedAt = Date.now();
    updateSyncedLabel();
  }

  let toastTimer = null;
  function toast(msg, opts) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("is-error", !!(opts && opts.error));
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2400);
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function mirrorStateToExtensionStorage() {
    if (!isExtensionRuntime || !window.chrome || !chrome.storage || !chrome.storage.local) return;
    try {
      const nextJobs = Array.isArray(state.jobs) ? state.jobs : [];
      const currentJobs = await data.getAllJobsIncludingTombstones();
      if (JSON.stringify(currentJobs) !== JSON.stringify(nextJobs)) {
        await data.replaceAllJobs(nextJobs);
      }

      if (state.profile) {
        const currentProfile = await data.getProfile();
        if (JSON.stringify(currentProfile) !== JSON.stringify(state.profile)) {
          await data.saveProfile(state.profile);
        }
      }

      const currentMappings = await new Promise((resolve) => {
        chrome.storage.local.get(data.AUTOFILL_MAPPINGS_KEY, (res) => {
          resolve((res && res[data.AUTOFILL_MAPPINGS_KEY]) || {});
        });
      });
      if (JSON.stringify(currentMappings) === JSON.stringify(state.autofillMappings || {})) return;

      await new Promise((resolve) => {
        chrome.storage.local.set({
          [data.AUTOFILL_MAPPINGS_KEY]: state.autofillMappings || {}
        }, () => resolve());
      });
    } catch (err) {
      console.warn("Extension storage mirror failed:", err);
    }
  }

  // ---------- OAuth via Google Identity Services ----------

  function hasValidClientId() {
    if (isExtensionRuntime) return true;
    return typeof config.googleClientId === "string"
      && config.googleClientId.length > 0
      && !/REPLACE_WITH_YOUR_CLIENT_ID/i.test(config.googleClientId);
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      throw new Error("Google Identity Services not loaded yet.");
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: config.googleClientId,
      scope: DRIVE_SCOPE,
      prompt: "",
      callback: (response) => {
        if (response && response.access_token) {
          currentToken = response.access_token;
          const expiresIn = Number(response.expires_in) || 3600;
          tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
          // Persist so a refresh within the token TTL skips Google entirely.
          writeCachedToken(currentToken, tokenExpiry);
          if (pendingTokenResolve) {
            pendingTokenResolve(currentToken);
            pendingTokenResolve = null;
          }
        } else if (pendingTokenResolve) {
          pendingTokenResolve(null);
          pendingTokenResolve = null;
        }
      },
      error_callback: (err) => {
        console.warn("OAuth error", err);
        if (pendingTokenResolve) {
          pendingTokenResolve(null);
          pendingTokenResolve = null;
        }
        // Silent refreshes on page boot often fail with "popup_closed" or
        // "user_interaction_required" — that's fine, it just means the user
        // needs to click Sign in again. Don't pop a scary toast.
        if (lastRequestInteractive) {
          toast("Sign-in cancelled or failed", { error: true });
        }
      }
    });
    return tokenClient;
  }

  async function requestToken(options) {
    // options.interactive = true triggers consent popup; false attempts silent refresh.
    const client = ensureTokenClient();
    lastRequestInteractive = !!(options && options.interactive);
    return new Promise((resolve) => {
      pendingTokenResolve = resolve;
      try {
        client.requestAccessToken({
          // "" prompts silent refresh if Google still has a valid grant;
          // "consent" forces the full chooser + consent screen.
          prompt: lastRequestInteractive ? "consent" : ""
        });
      } catch (err) {
        pendingTokenResolve = null;
        console.warn(err);
        resolve(null);
      }
    });
  }

  function waitForGis(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function poll() {
        if (window.google && google.accounts && google.accounts.oauth2) {
          resolve(true);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(poll, 80);
      })();
    });
  }

  async function tokenProvider() {
    if (isExtensionRuntime && driveAuth && typeof driveAuth.tokenProvider === "function") {
      return driveAuth.tokenProvider();
    }
    if (currentToken && Date.now() < tokenExpiry) return currentToken;
    // Cache may have been populated by attemptSilentRestore on boot.
    const cached = readCachedToken();
    if (cached) {
      currentToken = cached.token;
      tokenExpiry = cached.expiry;
      return currentToken;
    }
    // Try silent refresh. If user previously consented, this works.
    const silent = await requestToken({ interactive: false });
    if (silent) return silent;
    return null;
  }

  function clearToken() {
    if (isExtensionRuntime) {
      currentToken = null;
      tokenExpiry = 0;
      clearCachedToken();
      drive.invalidateFileCache();
      return;
    }
    if (currentToken && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(currentToken, () => {}); } catch (_) {}
    }
    currentToken = null;
    tokenExpiry = 0;
    clearCachedToken();
    drive.invalidateFileCache();
  }

  // ---------- Dataset ----------

  function recomputeStats() {
    const live = liveJobs();
    const counts = data.countByStatus(live);
    $("stat-total").textContent = live.length;
    $("stat-applied").textContent = counts.applied || 0;
    $("stat-interviewing").textContent = counts.interviewing || 0;
    $("stat-offer").textContent = counts.offer || 0;
    $("stat-rejected").textContent = counts.rejected || 0;
  }

  async function readExtensionDataset() {
    return {
      jobs: await data.getAllJobsIncludingTombstones(),
      profile: await data.getProfile(),
      autofillMappings: await data.getAutofillMappings()
    };
  }

  function applyDatasetToState(dataset) {
    const src = dataset && typeof dataset === "object" ? dataset : {};
    state.jobs = (src.jobs || []).map((j) => data.sanitizeJob(j));
    state.profile = src.profile || null;
    state.autofillMappings = src.autofillMappings || {};
    state.loaded = true;
  }

  async function loadFromExtensionStorage() {
    const dataset = await readExtensionDataset();
    applyDatasetToState(dataset);
    return dataset;
  }

  async function loadFromDrive(opts) {
    // Background pulls (every 15s / on focus) pass { silent: true } so the sync
    // pill doesn't flicker "Loading… → Synced" constantly. Explicit loads and
    // the initial sign-in still show progress.
    const silent = !!(opts && opts.silent);
    if (!silent) setSync("syncing", "Loading…");
    if (isExtensionRuntime) {
      const [localDataset, remoteDataset] = await Promise.all([
        readExtensionDataset(),
        drive.readData()
      ]);
      const mergedDataset = {
        jobs: data.mergeJobsByUpdatedAt(localDataset.jobs || [], remoteDataset.jobs || []),
        profile: remoteDataset.profile || localDataset.profile || null,
        autofillMappings: Object.assign(
          {},
          remoteDataset.autofillMappings || {},
          localDataset.autofillMappings || {}
        )
      };
      applyDatasetToState(mergedDataset);
      await mirrorStateToExtensionStorage();
      const remoteComparable = JSON.stringify({
        jobs: (remoteDataset.jobs || []).map((j) => data.sanitizeJob(j)),
        profile: remoteDataset.profile || null,
        autofillMappings: remoteDataset.autofillMappings || {}
      });
      const mergedComparable = JSON.stringify({
        jobs: state.jobs,
        profile: state.profile,
        autofillMappings: state.autofillMappings
      });
      if (remoteComparable !== mergedComparable) {
        await drive.writeData({
          jobs: state.jobs,
          profile: state.profile,
          autofillMappings: state.autofillMappings
        });
      }
      if (!silent) setSync("signed-in", "Synced");
      markSynced();
      return;
    }
    const dataset = await drive.readData();
    // Keep tombstones in state (we'll push them back to Drive on save, so they
    // continue to propagate) — but they're filtered out of every UI read.
    applyDatasetToState(dataset);
    await mirrorStateToExtensionStorage();
    if (!silent) setSync("signed-in", "Synced");
    markSynced();
  }

  // While `saveInFlight` is true we suppress the visibility/focus pull that
  // would otherwise read Drive (still showing the OLD state, since the PATCH
  // hasn't landed) and overwrite our just-edited local state. Without this
  // guard, switching tabs or losing focus mid-save reverts the UI from
  // "applied" back to "bookmarked".
  let saveInFlight = false;
  // We also track save FAILURES so the visibility-pull doesn't silently
  // overwrite a local edit that never made it to Drive. The user gets to
  // retry. lastFailedSave is cleared on successful save or sign-out.
  let lastSaveFailedAt = 0;
  const FAILED_SAVE_GUARD_MS = 30000; // hold local edits for 30 s after a failed save

  async function saveToDrive() {
    // Demo mode is a sandbox — let edits update the view but never touch Drive.
    if (state.demo) {
      setSync("", "Demo — not saved");
      return { ok: true, localOnly: true };
    }
    setSync("syncing", "Saving…");
    saveInFlight = true;
    try {
      if (isExtensionRuntime) {
        await mirrorStateToExtensionStorage();
        const signedIn = await driveAuth.isSignedIn();
        if (!signedIn) {
          lastSaveFailedAt = 0;
          setSync("", "Local only");
          return { ok: true, localOnly: true };
        }
      }
      await drive.writeData({
        jobs: state.jobs, // include tombstones so deletions propagate
        profile: state.profile,
        autofillMappings: state.autofillMappings
      });
      await mirrorStateToExtensionStorage();
      lastSaveFailedAt = 0;
      setSync("signed-in", "Synced");
      markSynced();
      return { ok: true, localOnly: false };
    } catch (err) {
      console.error("saveToDrive failed:", err);
      lastSaveFailedAt = Date.now();
      setSync("signed-in", "Save failed — retry");
      // Big visible toast — easy to miss the small sync pill text alone.
      toast("Save failed: " + (err && err.message ? err.message : "network error") + " — your changes are still in this tab; click Save again.", { error: true });
      return { ok: false, error: err };
    } finally {
      saveInFlight = false;
    }
  }

  function liveJobs() {
    return (state.jobs || []).filter((j) => !j.deletedAt);
  }

  // ---------- Rendering ----------

  function statusChip(status) {
    const color = data.statusColor(status);
    const label = data.statusLabel(status);
    return `<span class="status-chip" style="--chip:${color}">${escapeHtml(label)}</span>`;
  }

  // Inline status editor for the table — change a job's stage without opening
  // the modal. data-stop-row keeps the row's click-to-edit from firing.
  function statusSelectCell(j) {
    const color = data.statusColor(j.status);
    const opts = data.STATUS_ORDER.map((s) =>
      `<option value="${s}"${s === j.status ? " selected" : ""}>${escapeHtml(data.statusLabel(s))}</option>`
    ).join("");
    return `<select class="row-status" data-stop-row data-id="${escapeHtml(j.id)}" style="--chip:${color}" aria-label="Status">${opts}</select>`;
  }

  function fitCell(j) {
    if (j.aiFitAnalysis && typeof j.aiFitAnalysis.score === "number") {
      const title = j.aiFitAnalysis.summary || "CV ↔ JD fit score";
      return `<span class="fit-pill" style="--fit-color:${fitScoreColor(j.aiFitAnalysis.score)}" title="${escapeHtml(title)}">${j.aiFitAnalysis.score}</span>`;
    }
    return '<span class="cell-muted">—</span>';
  }

  function homeCountry() {
    const p = state.profile || {};
    return String(p.country || p.location || "").trim();
  }
  function jobEligibility(j) {
    return data.assessRemoteEligibility(j, homeCountry());
  }

  async function setJobStatusInline(id, newStatus) {
    const job = state.jobs.find((j) => j.id === id);
    if (!job || job.status === newStatus) return;
    const now = new Date().toISOString();
    const merged = Object.assign({}, job, { status: newStatus, updatedAt: now });
    merged.stageHistory = data.appendStageTransition(job.stageHistory || merged.stageHistory || [], newStatus, now);
    state.jobs = state.jobs.map((j) => (j.id === id ? data.sanitizeJob(merged) : j));
    renderJobs();
    const r = await saveToDrive();
    if (r && r.ok) {
      window.postMessage({ type: "JOBTRAIL_SYNC_REQUEST" }, "*");
      toast(r.localOnly ? "Status saved locally" : "Status updated");
    }
  }

  // Sortable columns: persisted to localStorage so the user's choice survives
  // refreshes. `dateApplied` desc is the sensible default — most-recent first.
  const SORT_PREF_KEY = "jobtrail_sort_pref_v1";
  const SORT_ORDER = ["bookmarked", "applying", "applied", "interviewing", "offer", "rejected", "archived"];
  const TYPE_FILTERS = [
    { id: "all", label: "All" },
    { id: "full-time", label: "Full-time" },
    { id: "part-time", label: "Part-time" },
    { id: "contract", label: "Contract" }
  ];
  let activeTypeFilter = "all";
  let hideRejected = false;
  try { hideRejected = localStorage.getItem("jobtrail_hide_rejected") === "1"; } catch (_) { /* ignore */ }
  let hideStale = false;
  try { hideStale = localStorage.getItem("jobtrail_hide_stale") === "1"; } catch (_) { /* ignore */ }
  let remoteOnly = false;
  try { remoteOnly = localStorage.getItem("jobtrail_remote_only") === "1"; } catch (_) { /* ignore */ }
  let hideRestricted = false;
  try { hideRestricted = localStorage.getItem("jobtrail_hide_restricted") === "1"; } catch (_) { /* ignore */ }

  const STALE_DAYS = 60;
  // A "stale" application: still sitting at Applied (no interview yet) and the
  // application date is more than ~2 months old — unlikely to hear back.
  function isStaleApplication(j) {
    if (j.status !== "applied" || !j.dateApplied) return false;
    const t = Date.parse(j.dateApplied);
    if (isNaN(t)) return false;
    return (Date.now() - t) / 86400000 > STALE_DAYS;
  }
  const sortState = (() => {
    try {
      const raw = localStorage.getItem(SORT_PREF_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.key === "string" && (parsed.dir === "asc" || parsed.dir === "desc")) {
          return { key: parsed.key, dir: parsed.dir };
        }
      }
    } catch (_) {}
    return { key: "dateApplied", dir: "desc" };
  })();

  function persistSortPref() {
    try { localStorage.setItem(SORT_PREF_KEY, JSON.stringify(sortState)); } catch (_) {}
  }

  function timeValue(value) {
    const stamp = value ? new Date(value).getTime() : 0;
    return Number.isFinite(stamp) ? stamp : 0;
  }

  function latestJobActivity(job) {
    return Math.max(
      timeValue(job && job.updatedAt),
      timeValue(job && job.createdAt),
      timeValue(job && job.dateApplied)
    );
  }

  function typeBucket(job) {
    const value = String((job && job.jobType) || "").trim().toLowerCase();
    if (!value) return "";
    if (value.includes("part")) return "part-time";
    if (value.includes("full")) return "full-time";
    if (value.includes("contract") || value.includes("freelance") || value.includes("temporary")) {
      return "contract";
    }
    return value.replace(/\s+/g, "-");
  }

  function renderTypeTabs() {
    if (!jobTypeTabs) return;
    const live = liveJobs();
    jobTypeTabs.innerHTML = TYPE_FILTERS.map((filter) => {
      const count = filter.id === "all"
        ? live.length
        : live.filter((job) => typeBucket(job) === filter.id).length;
      return `
        <button type="button" class="type-tab ${activeTypeFilter === filter.id ? "is-active" : ""}" data-type-filter="${escapeHtml(filter.id)}">
          <span>${escapeHtml(filter.label)}</span>
          <span class="type-tab-count">${count}</span>
        </button>
      `;
    }).join("");
  }

  function compareJobs(a, b, key, dir) {
    const mul = dir === "asc" ? 1 : -1;
    if (key === "status") {
      const ai = SORT_ORDER.indexOf(a.status); const bi = SORT_ORDER.indexOf(b.status);
      return mul * (ai - bi);
    }
    if (key === "fit") {
      const av = (a.aiFitAnalysis && typeof a.aiFitAnalysis.score === "number") ? a.aiFitAnalysis.score : -1;
      const bv = (b.aiFitAnalysis && typeof b.aiFitAnalysis.score === "number") ? b.aiFitAnalysis.score : -1;
      return mul * (av - bv);
    }
    if (key === "dateApplied") {
      // Empty dates sort last regardless of direction so blank rows don't leap
      // to the top of an ascending sort.
      const av = a.dateApplied || ""; const bv = b.dateApplied || "";
      if (!av && !bv) {
        const activityCmp = latestJobActivity(a) - latestJobActivity(b);
        if (activityCmp) return mul * activityCmp;
        return String(a.id || "").localeCompare(String(b.id || ""));
      }
      if (!av) return 1;
      if (!bv) return -1;
      const dateCmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (dateCmp) return mul * dateCmp;
      const activityCmp = latestJobActivity(a) - latestJobActivity(b);
      if (activityCmp) return mul * activityCmp;
      return String(a.id || "").localeCompare(String(b.id || ""));
    }
    const av = String((a[key] || "")).toLowerCase();
    const bv = String((b[key] || "")).toLowerCase();
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return mul * av.localeCompare(bv);
  }

  function applyHeaderSortIndicators() {
    document.querySelectorAll(".th-sortable").forEach((th) => {
      const key = th.getAttribute("data-sort-key");
      th.classList.toggle("is-sorted", key === sortState.key);
      th.classList.toggle("sorted-asc", key === sortState.key && sortState.dir === "asc");
      th.classList.toggle("sorted-desc", key === sortState.key && sortState.dir === "desc");
    });
  }

  function filteredJobs() {
    const q = (jobsSearch.value || "").trim().toLowerCase();
    const status = jobsFilterStatus.value;
    const list = liveJobs().filter((j) => {
      if (hideRejected && j.status === "rejected") return false;
      if (hideStale && isStaleApplication(j)) return false;
      if (remoteOnly || hideRestricted) {
        const e = jobEligibility(j);
        if (remoteOnly && !e.remote) return false;
        if (hideRestricted && e.eligibility === "restricted") return false;
      }
      if (status && j.status !== status) return false;
      if (activeTypeFilter !== "all" && typeBucket(j) !== activeTypeFilter) return false;
      if (!q) return true;
      const hay = [j.jobTitle, j.company, j.location, j.workMode, j.jobType, j.notes].join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    return list.sort((a, b) => compareJobs(a, b, sortState.key, sortState.dir));
  }

  function renderJobs() {
    const jobs = filteredJobs();
    renderTypeTabs();
    jobsEmpty.hidden = jobs.length !== 0;
    jobsTbody.innerHTML = jobs.map((j) => {
      const urlLink = j.url
        ? `<a href="${escapeHtml(j.url)}" target="_blank" rel="noopener noreferrer" data-stop-row>Open</a>`
        : "";
      const hasPrep = data.hasInterviewPrepContent && data.hasInterviewPrepContent(j.interviewPrep);
      const prepBadge = hasPrep ? '<span class="jd-badge" title="Interview prep saved">🎤</span>' : "";
      const ivCount = Array.isArray(j.interviews) ? j.interviews.length : 0;
      const interviewsBadge = ivCount
        ? `<span class="jd-badge" title="${ivCount} interview round${ivCount === 1 ? "" : "s"} logged">🗂️${ivCount}</span>`
        : "";
      const elig = jobEligibility(j);
      const remoteBadge = elig.eligibility === "restricted"
        ? `<span class="jd-badge badge-warn" title="${escapeHtml(elig.reason || "Region-restricted")}">⚠ region</span>`
        : "";
      const letterBadge = (j.aiCoverLetter && j.aiCoverLetter.text)
        ? '<span class="jd-badge" title="AI cover letter cached">✉️</span>' : "";
      return `
        <tr class="job-row" data-action="edit" data-id="${escapeHtml(j.id)}" tabindex="0" role="button" aria-label="Edit ${escapeHtml(j.jobTitle || "job")}">
          <td class="job-title-cell">
            <strong>${escapeHtml(j.jobTitle || "(untitled)")}</strong>
            ${j.description ? '<span class="jd-badge" title="Job description archived">📄</span>' : ""}
            ${prepBadge}
            ${interviewsBadge}
            ${remoteBadge}
            ${letterBadge}
            ${urlLink}
          </td>
          <td>${escapeHtml(j.company || "")}</td>
          <td>${escapeHtml(j.location || "")}</td>
          <td>${j.workMode ? escapeHtml(j.workMode) : '<span class="cell-muted">—</span>'}</td>
          <td>${j.jobType ? escapeHtml(j.jobType) : '<span class="cell-muted">—</span>'}</td>
          <td>${statusSelectCell(j)}</td>
          <td class="fit-cell">${fitCell(j)}</td>
          <td>${escapeHtml(j.dateApplied || "")}</td>
          <td>
            <div class="row-actions">
              <button class="primary-button" data-action="edit" data-id="${escapeHtml(j.id)}">Edit</button>
              <button class="row-delete-button" data-action="delete" data-id="${escapeHtml(j.id)}" data-stop-row>Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
    applyHeaderSortIndicators();
    recomputeStats();
    renderFunnel();
  }

  // Header click: cycle the column's sort. Same column → flip direction.
  // Different column → switch and pick a sensible default direction.
  document.querySelectorAll(".th-sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort-key");
      if (!key) return;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.key = key;
        // Dates and statuses default to "newest first"; text columns to A→Z.
        sortState.dir = (key === "dateApplied" || key === "status") ? "desc" : "asc";
      }
      persistSortPref();
      renderJobs();
    });
  });

  // ---------- Funnel analytics ----------

  // Ordered pipeline: each stage includes everyone who has reached at least
  // that stage. "Rejected" collapses to a side-bucket because we don't know
  // where in the flow the rejection happened from the current status alone.
  const FUNNEL_STAGES = [
    { id: "bookmarked",   label: "Bookmarked",    includes: ["bookmarked", "applying", "applied", "interviewing", "offer"] },
    { id: "applying",     label: "Applying",      includes: ["applying", "applied", "interviewing", "offer"] },
    { id: "applied",      label: "Applied",       includes: ["applied", "interviewing", "offer"] },
    { id: "interviewing", label: "Interviewing",  includes: ["interviewing", "offer"] },
    { id: "offer",        label: "Offer",         includes: ["offer"] }
  ];

  function countAtOrPast(jobs, stageIds) {
    const set = new Set(stageIds);
    return jobs.filter((j) => set.has(j.status)).length;
  }

  function pct(n, d) {
    if (!d) return 0;
    return Math.round((n / d) * 100);
  }

  function formatScheduledAt(value) {
    if (!value) return "";
    // datetime-local values look like "2026-05-01T14:30" (no tz). Parse as local.
    const d = new Date(value);
    if (isNaN(d.getTime())) return escapeHtml(value);
    return d.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  }

  function renderFunnel() {
    if (!funnelSection || funnelSection.hidden) return;
    const live = liveJobs();
    const total = live.length;

    // Active pipeline = anything not rejected/archived. That's the funnel's
    // denominator: jobs that could still progress. Rejected/archived are
    // shown on the side so the main bars stay clean.
    const active = live.filter((j) => j.status !== "rejected" && j.status !== "archived");
    const rejected = live.filter((j) => j.status === "rejected").length;
    const archived = live.filter((j) => j.status === "archived").length;

    // Bars — widths are relative to the top stage, not total (so the shape
    // actually looks like a funnel).
    const stageCounts = FUNNEL_STAGES.map((stage) => ({
      id: stage.id,
      label: stage.label,
      count: countAtOrPast(active, stage.includes)
    }));
    const topCount = stageCounts[0].count || 0;

    $("funnel-bars").innerHTML = stageCounts.map((s) => {
      const width = topCount ? Math.max(4, Math.round((s.count / topCount) * 100)) : 4;
      const pctOfTop = topCount ? pct(s.count, topCount) : 0;
      return `
        <div class="funnel-row">
          <div class="funnel-row-label">${escapeHtml(s.label)}</div>
          <div class="funnel-bar-wrap">
            <div class="funnel-bar" style="width:${width}%"></div>
            <div class="funnel-bar-value">${s.count}<span class="funnel-bar-pct"> · ${pctOfTop}%</span></div>
          </div>
        </div>
      `;
    }).join("");

    // Stage-to-stage conversion rates — the interesting numbers.
    const conv = [];
    for (let i = 0; i < stageCounts.length - 1; i++) {
      const from = stageCounts[i];
      const to = stageCounts[i + 1];
      conv.push({
        label: `${from.label} → ${to.label}`,
        rate: pct(to.count, from.count),
        from: from.count,
        to: to.count
      });
    }
    $("funnel-conversions").innerHTML = conv.map((c) => `
      <div class="conv-card">
        <div class="conv-rate">${c.rate}%</div>
        <div class="conv-label">${escapeHtml(c.label)}</div>
        <div class="conv-frac">${c.to} of ${c.from}</div>
      </div>
    `).join("");

    // Outcomes side card.
    const outcomes = [
      { label: "In pipeline", n: active.length, color: "var(--teal-700)" },
      { label: "Offers",      n: stageCounts[4].count, color: "#3e956a" },
      { label: "Rejected",    n: rejected, color: "#9e5c63" },
      { label: "Archived",    n: archived, color: "#6b7280" },
      { label: "Total ever",  n: total, color: "var(--text)" }
    ];
    $("funnel-outcomes").innerHTML = outcomes.map((o) => `
      <li><span class="dot" style="background:${o.color}"></span>${escapeHtml(o.label)}<b>${o.n}</b></li>
    `).join("");

    // Upcoming interviews — pull from per-job interviewPrep.scheduledAt.
    const now = Date.now();
    const upcoming = live
      .filter((j) => j.interviewPrep && j.interviewPrep.scheduledAt)
      .map((j) => {
        const when = new Date(j.interviewPrep.scheduledAt).getTime();
        return { job: j, when };
      })
      .filter((x) => Number.isFinite(x.when) && x.when >= now - 1000 * 60 * 60 * 6) // include recent past 6h
      .sort((a, b) => a.when - b.when)
      .slice(0, 8);
    const upcomingEl = $("funnel-upcoming");
    if (!upcoming.length) {
      upcomingEl.innerHTML = '<li class="muted">None scheduled.</li>';
    } else {
      upcomingEl.innerHTML = upcoming.map(({ job }) => `
        <li>
          <button type="button" class="upcoming-link" data-action="edit" data-id="${escapeHtml(job.id)}">
            <span class="upcoming-when">${formatScheduledAt(job.interviewPrep.scheduledAt)}</span>
            <span class="upcoming-title">${escapeHtml(job.jobTitle || "(untitled)")}</span>
            <span class="upcoming-company">${escapeHtml(job.company || "")}${
              job.interviewPrep.nextRound ? " · " + escapeHtml(job.interviewPrep.nextRound) : ""
            }</span>
          </button>
        </li>
      `).join("");
    }
  }

  // ---------- View switching ----------

  function setView(view) {
    currentView = (view === "funnel" || view === "analytics" || view === "discover") ? view : "pipeline";
    document.querySelectorAll(".view-tab").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.view === currentView);
    });
    const analyticsSection = $("analytics-section");
    const discoverSection = $("discover-section");
    if (analyticsSection) analyticsSection.hidden = currentView !== "analytics";
    if (discoverSection) discoverSection.hidden = currentView !== "discover";
    if (currentView === "analytics") {
      jobsSection.hidden = true;
      funnelSection.hidden = true;
      renderAnalytics();
    } else if (currentView === "funnel") {
      jobsSection.hidden = true;
      funnelSection.hidden = false;
      renderFunnel();
    } else if (currentView === "discover") {
      jobsSection.hidden = true;
      funnelSection.hidden = true;
      onEnterDiscover();
    } else {
      funnelSection.hidden = true;
      jobsSection.hidden = false;
      renderJobs();
    }
  }

  if (viewTabs) {
    viewTabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".view-tab");
      if (!btn) return;
      setView(btn.dataset.view);
    });
  }

  // ---- Discover feed + saved searches -------------------------------------
  // Pulls live remote roles via /api/discover (Remotive proxy), flags
  // eligibility for the user's region, lets them one-click "Track" a role into
  // the pipeline, and remembers saved searches so new matches can be surfaced.
  const SAVED_SEARCHES_KEY = "jobtrail_saved_searches";
  let savedSearches = loadSavedSearches();
  let discoverResults = [];
  let discoverLoadedOnce = false;
  let discoverActiveSavedId = null;

  function loadSavedSearches() {
    try {
      const raw = JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((s) => s && typeof s.search === "string") : [];
    } catch (_) { return []; }
  }
  function persistSavedSearches() {
    try { localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(savedSearches)); } catch (_) { /* ignore */ }
  }
  function searchLabel(s) {
    const parts = [];
    if (s.search) parts.push(`"${s.search}"`);
    if (s.category) {
      const opt = $("discover-category") && [...$("discover-category").options].find((o) => o.value === s.category);
      parts.push(opt ? opt.textContent : s.category);
    }
    if (s.eligibleOnly) parts.push("eligible only");
    return parts.join(" · ") || "All remote jobs";
  }
  function searchKey(s) {
    return `${(s.category || "").toLowerCase()}|${(s.search || "").toLowerCase()}|${s.eligibleOnly ? 1 : 0}`;
  }

  async function fetchDiscover({ search, category, limit }) {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    params.set("limit", String(limit || 30));
    const res = await fetch("/api/discover?" + params.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("discover_http_" + res.status);
    const data = await res.json();
    return Array.isArray(data.jobs) ? data.jobs : [];
  }

  function alreadyTracked(remoteJob) {
    const url = String(remoteJob.url || "").toLowerCase();
    const title = data.normalizeText(remoteJob.title || "");
    const company = data.normalizeText(remoteJob.company || "");
    return (state.jobs || []).some((j) => {
      if (j.deletedAt) return false;
      if (url && String(j.url || "").toLowerCase() === url) return true;
      return title && company && j.titleFingerprint === title && j.companyFingerprint === company;
    });
  }

  function discoverCardHtml(rj) {
    const elig = data.assessRemoteEligibility(rj, homeCountry());
    let badge = "";
    if (elig.eligibility === "restricted") {
      badge = `<span class="disc-badge disc-warn" title="${escapeHtml(elig.reason || "Region-restricted")}">⚠ ${escapeHtml(elig.reason || "Region-locked")}</span>`;
    } else if (elig.eligibility === "eligible") {
      badge = `<span class="disc-badge disc-ok" title="${escapeHtml(elig.reason || "Open to your region")}">✓ You can apply</span>`;
    } else {
      badge = `<span class="disc-badge disc-unknown">Region unclear</span>`;
    }
    const loc = rj.candidate_required_location || "Remote";
    const tracked = alreadyTracked(rj);
    const trackBtn = tracked
      ? `<button class="ghost-button" disabled>✓ Tracked</button>`
      : `<button class="primary-button" data-action="track-discover" data-id="${escapeHtml(rj.id)}">+ Track</button>`;
    const published = rj.publishedAt ? formatRelative(rj.publishedAt) : "";
    return `
      <article class="disc-card" data-elig="${elig.eligibility}">
        <div class="disc-card-head">
          <div class="disc-card-title">
            <strong>${escapeHtml(rj.title || "(untitled)")}</strong>
            <span class="disc-company">${escapeHtml(rj.company || "")}</span>
          </div>
          ${badge}
        </div>
        <div class="disc-meta">
          <span title="Accepted location">📍 ${escapeHtml(loc)}</span>
          ${rj.jobType ? `<span>• ${escapeHtml(String(rj.jobType).replace(/_/g, " "))}</span>` : ""}
          ${rj.salary ? `<span class="disc-salary">• 💷 ${escapeHtml(rj.salary)}</span>` : ""}
          ${published ? `<span>• ${escapeHtml(published)}</span>` : ""}
          ${rj.source ? `<span class="disc-source" title="Source board">${escapeHtml(rj.source)}</span>` : ""}
        </div>
        <div class="disc-actions">
          <a class="ghost-button" href="${escapeHtml(rj.url)}" target="_blank" rel="noopener noreferrer">View posting ↗</a>
          ${trackBtn}
        </div>
      </article>`;
  }

  function formatRelative(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "1 day ago";
    if (days < 30) return days + " days ago";
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : months + " months ago";
  }

  function renderDiscoverResults() {
    const grid = $("discover-grid");
    const status = $("discover-status");
    if (!grid) return;
    const eligibleOnly = $("discover-eligible-only") && $("discover-eligible-only").checked;
    let list = discoverResults;
    if (eligibleOnly) {
      list = list.filter((rj) => data.assessRemoteEligibility(rj, homeCountry()).eligibility !== "restricted");
    }
    if (!list.length) {
      grid.innerHTML = "";
      if (status) status.textContent = discoverResults.length
        ? "No roles open to your region in these results. Untick “Eligible only” to see all."
        : "No roles found. Try a different search or category.";
      return;
    }
    if (status) {
      const restricted = discoverResults.filter((rj) => data.assessRemoteEligibility(rj, homeCountry()).eligibility === "restricted").length;
      status.textContent = `${list.length} role${list.length === 1 ? "" : "s"} shown`
        + (restricted && !eligibleOnly ? ` · ${restricted} region-locked` : "");
    }
    grid.innerHTML = list.map(discoverCardHtml).join("");
  }

  async function runDiscover({ search, category, eligibleOnly, savedId } = {}) {
    const grid = $("discover-grid");
    const status = $("discover-status");
    const searchEl = $("discover-search");
    const catEl = $("discover-category");
    const eligEl = $("discover-eligible-only");
    if (search != null && searchEl) searchEl.value = search;
    if (category != null && catEl) catEl.value = category;
    if (eligibleOnly != null && eligEl) eligEl.checked = eligibleOnly;
    discoverActiveSavedId = savedId || null;

    const q = {
      search: (searchEl && searchEl.value || "").trim(),
      category: (catEl && catEl.value) || "",
      limit: 40
    };
    if (status) status.textContent = "Searching live remote roles…";
    if (grid) grid.innerHTML = "";
    discoverLoadedOnce = true;
    try {
      discoverResults = await fetchDiscover(q);
      // If this came from / matches a saved search, mark its current results seen.
      markSavedSearchSeen(q, discoverResults);
      renderDiscoverResults();
    } catch (err) {
      discoverResults = [];
      if (status) status.textContent = "Couldn't load remote jobs right now. This needs the live site (Netlify functions) — it won't work from a local file preview.";
      console.error("Discover fetch failed:", err);
    }
  }

  function saveCurrentSearch() {
    const searchEl = $("discover-search");
    const catEl = $("discover-category");
    const eligEl = $("discover-eligible-only");
    const entry = {
      id: data.generateId ? data.generateId() : String(Date.now()),
      search: (searchEl && searchEl.value || "").trim(),
      category: (catEl && catEl.value) || "",
      eligibleOnly: !!(eligEl && eligEl.checked),
      seenIds: discoverResults.map((rj) => rj.id),
      newCount: 0,
      createdAt: new Date().toISOString()
    };
    if (!entry.search && !entry.category) {
      toast("Add a keyword or category before saving a search.", { error: true });
      return;
    }
    const key = searchKey(entry);
    if (savedSearches.some((s) => searchKey(s) === key)) {
      toast("You've already saved this search.");
      return;
    }
    savedSearches.unshift(entry);
    persistSavedSearches();
    renderSavedSearches();
    toast("Search saved. We'll flag new matches.");
    // Opt-in: ask once, at this natural moment, so we can ping on new matches
    // even when the user is on another tab. Best-effort — never blocks.
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
    } catch (_) { /* ignore */ }
  }

  function deleteSavedSearch(id) {
    savedSearches = savedSearches.filter((s) => s.id !== id);
    persistSavedSearches();
    renderSavedSearches();
    updateDiscoverDot();
  }

  function renderSavedSearches() {
    const wrap = $("saved-searches");
    if (!wrap) return;
    if (!savedSearches.length) { wrap.hidden = true; wrap.innerHTML = ""; return; }
    wrap.hidden = false;
    wrap.innerHTML = `<span class="saved-label">Saved searches</span>` + savedSearches.map((s) => {
      const dot = s.newCount > 0 ? `<span class="saved-new" title="${s.newCount} new since you last looked">${s.newCount} new</span>` : "";
      return `<span class="saved-chip${s.id === discoverActiveSavedId ? " is-active" : ""}" data-saved-id="${escapeHtml(s.id)}">
        <button type="button" class="saved-run" data-action="run-saved" data-id="${escapeHtml(s.id)}">${escapeHtml(searchLabel(s))}</button>
        ${dot}
        <button type="button" class="saved-del" data-action="del-saved" data-id="${escapeHtml(s.id)}" title="Remove saved search">×</button>
      </span>`;
    }).join("");
  }

  // Compare freshly fetched results against what a saved search last saw.
  function markSavedSearchSeen(query, jobs) {
    const key = searchKey({ search: query.search, category: query.category, eligibleOnly: false });
    let changed = false;
    savedSearches.forEach((s) => {
      if (searchKey({ search: s.search, category: s.category, eligibleOnly: false }) !== key) return;
      s.seenIds = jobs.map((rj) => rj.id);
      if (s.newCount) { s.newCount = 0; changed = true; }
    });
    if (changed) { persistSavedSearches(); renderSavedSearches(); updateDiscoverDot(); }
  }

  // Background refresh: quietly re-run each saved search and count unseen ids.
  async function refreshSavedSearchCounts() {
    if (!savedSearches.length) return;
    let changed = false;
    let totalNew = 0;
    await Promise.all(savedSearches.map(async (s) => {
      try {
        const jobs = await fetchDiscover({ search: s.search, category: s.category, limit: 40 });
        const seen = new Set(s.seenIds || []);
        const fresh = jobs.filter((rj) => !seen.has(rj.id));
        const n = fresh.length;
        totalNew += n;
        if (n !== s.newCount) { s.newCount = n; changed = true; }
      } catch (_) { /* leave count as-is on network error */ }
    }));
    if (changed) {
      persistSavedSearches();
      renderSavedSearches();
      updateDiscoverDot();
      notifyNewMatches(totalNew);
    }
  }

  // Best-effort desktop ping when saved searches surface new roles. Only fires
  // if the user already granted permission (we ask at save time), so it never
  // nags. Falls back silently to the in-app dot/count.
  function notifyNewMatches(total) {
    if (!total) return;
    try {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const n = new Notification("JobTrail · new remote matches", {
        body: `${total} new role${total === 1 ? "" : "s"} match your saved searches.`,
        tag: "jobtrail-discover"
      });
      n.onclick = () => { window.focus(); setView("discover"); n.close(); };
    } catch (_) { /* ignore */ }
  }

  function updateDiscoverDot() {
    const dot = $("discover-dot");
    if (!dot) return;
    const total = savedSearches.reduce((n, s) => n + (s.newCount || 0), 0);
    dot.hidden = total === 0;
    dot.textContent = total > 0 ? String(total) : "";
  }

  function findDiscoverJob(id) {
    return discoverResults.find((r) => r.id === id) || dailyPicks.find((r) => r.id === id);
  }

  function trackDiscoverJob(id) {
    const rj = findDiscoverJob(id);
    if (!rj) return;
    if (alreadyTracked(rj)) { toast("Already in your pipeline."); return; }
    const elig = data.assessRemoteEligibility(rj, homeCountry());
    const sanitized = data.sanitizeJob({
      jobTitle: rj.title,
      company: rj.company,
      url: rj.url,
      workMode: "Remote",
      location: rj.candidate_required_location || "Remote",
      jobType: (rj.jobType || "").replace(/_/g, " "),
      salary: rj.salary || "",
      description: rj.description || "",
      status: "bookmarked",
      notes: elig.eligibility === "restricted" ? `⚠ Region note: ${elig.reason}` : ""
    });
    state.jobs.unshift(sanitized);
    renderDiscoverResults();
    renderDailyPicks();
    if (currentView === "pipeline") renderJobs();
    saveToDrive().then((r) => {
      if (!r.ok) return;
      window.postMessage({ type: "JOBTRAIL_SYNC_REQUEST" }, "*");
      toast(r.localOnly ? "Tracked locally" : "Tracked to pipeline");
    });
  }

  // ---- Today's picks: a once-per-day curated batch of remote roles ---------
  // Runs client-side (no server cron can write to your Drive), but the cadence
  // is identical from your side: the first time you open the app on a new
  // calendar day, we fetch a fresh batch, filter it, and cache it for the day.
  const DAILY_PICKS_KEY = "jobtrail_daily_picks";
  const DAILY_TARGET = 35;
  const SALARY_FLOOR_GBP = 25000;
  let dailyPicks = [];

  function todayStr() { return new Date().toISOString().slice(0, 10); }

  // Best-effort annual-GBP estimate from Remotive's free-text salary strings
  // (e.g. "$120k - $150k", "£40,000", "€50k / year", "$30/hr"). Returns null
  // when nothing parseable is present — callers treat null as "unknown, keep".
  function parseAnnualGbp(salaryRaw) {
    const s = String(salaryRaw || "").toLowerCase();
    if (!s) return null;
    let fx = 1; // assume GBP unless a foreign symbol/code appears
    if (s.includes("$") || /\busd\b|\bcad\b|\baud\b/.test(s)) fx = 0.79;
    else if (s.includes("€") || /\beur\b/.test(s)) fx = 0.85;
    const nums = [];
    const re = /(\d[\d,.]*)\s*(k)?/g;
    let m;
    while ((m = re.exec(s))) {
      let n = parseFloat(m[1].replace(/,/g, ""));
      if (isNaN(n)) continue;
      if (m[2]) n *= 1000;
      if (n > 0) nums.push(n);
    }
    if (!nums.length) return null;
    let val = Math.max.apply(null, nums);
    if (/\bhour\b|\bhourly\b|\/hr\b|\/h\b|per hour|an hour/.test(s)) val *= 2080;
    else if (/\bmonth\b|\bmonthly\b|\/mo\b|per month|a month/.test(s)) val *= 12;
    else if (/\bday\b|\bdaily\b|per day|a day/.test(s)) val *= 220;
    return val * fx;
  }

  // Your chosen daily rules: drop region-locked (US-only etc.) roles, drop
  // roles whose listed pay is below the floor (unlisted salary is kept), and
  // drop anything already in your pipeline — tracked or rejected.
  function passesDailyFilter(rj) {
    if (alreadyTracked(rj)) return false;
    const elig = data.assessRemoteEligibility(rj, homeCountry());
    if (elig.eligibility === "restricted") return false;
    const gbp = parseAnnualGbp(rj.salary);
    if (gbp != null && gbp < SALARY_FLOOR_GBP) return false;
    return true;
  }

  // Rank the daily picks so the strongest surface first: eligible > unknown,
  // a stated salary is a plus, and fresher postings score higher.
  function pickScore(rj) {
    let s = 0;
    const elig = data.assessRemoteEligibility(rj, homeCountry());
    if (elig.eligibility === "eligible") s += 30;
    else if (elig.eligibility === "unknown") s += 10;
    if (parseAnnualGbp(rj.salary) != null) s += 15;
    const ts = new Date(rj.publishedAt).getTime();
    if (!isNaN(ts)) s += Math.max(0, 20 - ((Date.now() - ts) / 86400000) * 3);
    return s;
  }

  function renderDailyPicks() {
    const grid = $("daily-grid");
    const status = $("daily-status");
    const count = $("daily-count");
    if (!grid) return;
    if (!dailyPicks.length) {
      grid.innerHTML = "";
      if (count) count.textContent = "";
      return;
    }
    if (count) count.textContent = `· ${dailyPicks.length}`;
    if (status) status.textContent = `${dailyPicks.length} fresh remote role${dailyPicks.length === 1 ? "" : "s"} for ${todayStr()} — region-locked and under £${(SALARY_FLOOR_GBP / 1000)}k roles filtered out.`;
    grid.innerHTML = dailyPicks.map(discoverCardHtml).join("");
  }

  async function loadDailyPicks(force) {
    const status = $("daily-status");
    if (!force) {
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(DAILY_PICKS_KEY) || "null"); } catch (_) { cached = null; }
      if (cached && cached.date === todayStr() && Array.isArray(cached.jobs) && cached.jobs.length) {
        dailyPicks = cached.jobs;
        renderDailyPicks();
        return;
      }
    }
    if (status) status.textContent = "Fetching today's remote picks…";
    try {
      // Pull the latest broad batch, then filter + rank down to the target.
      const jobs = await fetchDiscover({ limit: 100 });
      dailyPicks = jobs.filter(passesDailyFilter)
        .sort((a, b) => pickScore(b) - pickScore(a))
        .slice(0, DAILY_TARGET);
      try { localStorage.setItem(DAILY_PICKS_KEY, JSON.stringify({ date: todayStr(), jobs: dailyPicks })); } catch (_) { /* ignore quota */ }
      renderDailyPicks();
    } catch (err) {
      dailyPicks = [];
      if (status) status.textContent = "Couldn't load today's picks right now. This needs the live site (Netlify functions) — it won't work from a local file preview.";
      console.error("Daily picks fetch failed:", err);
    }
  }

  function onEnterDiscover() {
    renderSavedSearches();
    updateDiscoverDot();
    loadDailyPicks(false);
  }

  const discoverForm = $("discover-form");
  if (discoverForm) {
    discoverForm.addEventListener("submit", (e) => {
      e.preventDefault();
      runDiscover({});
    });
  }
  const discoverEligEl = $("discover-eligible-only");
  if (discoverEligEl) discoverEligEl.addEventListener("change", renderDiscoverResults);
  const discoverSaveBtn = $("discover-save-btn");
  if (discoverSaveBtn) discoverSaveBtn.addEventListener("click", saveCurrentSearch);

  const discoverGrid = $("discover-grid");
  if (discoverGrid) {
    discoverGrid.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action='track-discover']");
      if (btn) trackDiscoverJob(btn.dataset.id);
    });
  }
  const dailyGrid = $("daily-grid");
  if (dailyGrid) {
    dailyGrid.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action='track-discover']");
      if (btn) trackDiscoverJob(btn.dataset.id);
    });
  }
  const dailyRefreshBtn = $("daily-refresh");
  if (dailyRefreshBtn) dailyRefreshBtn.addEventListener("click", () => loadDailyPicks(true));
  const savedSearchesEl = $("saved-searches");
  if (savedSearchesEl) {
    savedSearchesEl.addEventListener("click", (e) => {
      const runBtn = e.target.closest("[data-action='run-saved']");
      if (runBtn) {
        const s = savedSearches.find((x) => x.id === runBtn.dataset.id);
        if (s) runDiscover({ search: s.search, category: s.category, eligibleOnly: s.eligibleOnly, savedId: s.id });
        return;
      }
      const delBtn = e.target.closest("[data-action='del-saved']");
      if (delBtn) deleteSavedSearch(delBtn.dataset.id);
    });
  }

  function populateStatusSelects() {
    const options = data.STATUS_ORDER.map(
      (s) => `<option value="${s}">${escapeHtml(data.statusLabel(s))}</option>`
    ).join("");
    jobsFilterStatus.insertAdjacentHTML("beforeend", options);
    $("field-status").innerHTML = options;
  }

  // ---------- Modal ----------

  // Interview rounds: a per-job list, each row a label + date + its own notes.
  function interviewRowHtml(iv) {
    iv = iv || {};
    return `<div class="interview-round" data-interview>
      <div class="interview-round-head">
        <input class="iv-label" type="text" placeholder="Round — e.g. Recruiter screen, Tech, Final" value="${escapeHtml(iv.label || "")}">
        <input class="iv-date" type="datetime-local" value="${escapeHtml(iv.date || "")}">
        <button type="button" class="iv-remove" title="Remove round" aria-label="Remove round">✕</button>
      </div>
      <textarea class="iv-notes" rows="3" placeholder="Notes — who you met, questions asked, how it went, follow-ups…">${escapeHtml(iv.notes || "")}</textarea>
    </div>`;
  }
  function renderInterviews(list) {
    const wrap = $("interviews-list");
    if (!wrap) return;
    wrap.innerHTML = (Array.isArray(list) ? list : []).map(interviewRowHtml).join("");
  }
  function readInterviews() {
    const wrap = $("interviews-list");
    if (!wrap) return [];
    return Array.from(wrap.querySelectorAll(".interview-round")).map((row) => ({
      label: (row.querySelector(".iv-label") || {}).value || "",
      date: (row.querySelector(".iv-date") || {}).value || "",
      notes: (row.querySelector(".iv-notes") || {}).value || ""
    }));
  }

  function openModal(job) {
    const isNew = !job;
    jobModalTitle.textContent = isNew ? "Add job" : "Edit job";
    jobDeleteBtn.hidden = isNew;
    const base = job || {};
    $("field-id").value = base.id || "";
    $("field-jobTitle").value = base.jobTitle || "";
    $("field-company").value = base.company || "";
    $("field-location").value = base.location || "";
    $("field-workMode").value = base.workMode || "";
    $("field-jobType").value = base.jobType || "";
    $("field-status").value = base.status || "bookmarked";
    $("field-salary").value = base.salary || "";
    $("field-dateApplied").value = base.dateApplied || "";
    $("field-url").value = base.url || "";
    $("field-notes").value = base.notes || "";
    const descEl = $("field-description");
    if (descEl) {
      descEl.value = base.description || "";
      descEl.hidden = true;
      const toggleBtn = $("field-description-toggle");
      if (toggleBtn) toggleBtn.textContent = descEl.value ? "Show" : "Add";
      const emptyHint = $("field-description-empty");
      if (emptyHint) emptyHint.hidden = Boolean(descEl.value);
    }

    // Interview prep block. Auto-expand when there's existing content so the
    // user sees it without hunting for the toggle; keep collapsed for empty.
    const prep = (base && base.interviewPrep) || {};
    $("field-prep-nextRound").value = prep.nextRound || "";
    $("field-prep-scheduledAt").value = prep.scheduledAt || "";
    $("field-prep-interviewers").value = prep.interviewers || "";
    $("field-prep-questionsToAsk").value = prep.questionsToAsk || "";
    $("field-prep-starStories").value = prep.starStories || "";
    $("field-prep-notes").value = prep.notes || "";
    const prepBody = $("field-prep-body");
    const prepToggle = $("field-prep-toggle");
    const hasPrep = data.hasInterviewPrepContent && data.hasInterviewPrepContent(prep);
    if (prepBody) prepBody.hidden = !hasPrep;
    if (prepToggle) prepToggle.textContent = hasPrep ? "Hide" : "Add prep";

    // Interview rounds — auto-expand when there are any logged.
    const interviews = (base && Array.isArray(base.interviews)) ? base.interviews : [];
    renderInterviews(interviews);
    const ivBody = $("field-interviews-body");
    const ivToggle = $("field-interviews-toggle");
    if (ivBody) ivBody.hidden = interviews.length === 0;
    if (ivToggle) ivToggle.textContent = interviews.length ? "Hide" : "Add interview";

    // AI cover letter block: preload cached letter if present; auto-expand so
    // users can see it without hunting for a toggle when one already exists.
    const aiBody = document.getElementById("ai-cover-body");
    const aiToggle = document.getElementById("ai-cover-toggle");
    const hasCachedLetter = Boolean(base && base.aiCoverLetter && base.aiCoverLetter.text);
    if (aiBody) aiBody.hidden = !hasCachedLetter;
    if (aiToggle) aiToggle.textContent = hasCachedLetter ? "Hide" : "Show";
    loadCachedCoverLetterIntoModal(base);

    // Fit analysis: preload cached score and auto-expand when one exists.
    const fitBody = document.getElementById("ai-fit-body");
    const fitToggle = document.getElementById("ai-fit-toggle");
    const hasCachedFit = Boolean(base && base.aiFitAnalysis);
    if (fitBody) fitBody.hidden = !hasCachedFit;
    if (fitToggle) fitToggle.textContent = hasCachedFit ? "Hide" : "Show";
    loadCachedFitIntoModal(base);

    // Status timeline: preload, auto-expand if there are 2+ entries (a real
    // timeline). New jobs with just the seed entry stay collapsed by default.
    const tlBody = document.getElementById("field-timeline-body");
    const tlToggle = document.getElementById("field-timeline-toggle");
    const tlHistory = (base && Array.isArray(base.stageHistory)) ? base.stageHistory : [];
    const hasMeaningfulTimeline = tlHistory.length > 1;
    if (tlBody) tlBody.hidden = !hasMeaningfulTimeline;
    if (tlToggle) tlToggle.textContent = hasMeaningfulTimeline ? "Hide" : "Show";
    renderStageTimeline(tlHistory);

    jobModal.hidden = false;
    setTimeout(() => $("field-jobTitle").focus(), 10);
  }

  function closeModal() { jobModal.hidden = true; }

  jobModal.addEventListener("click", (e) => {
    if (e.target && e.target.matches("[data-close-modal]")) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !jobModal.hidden) closeModal();
  });

  // Collapsible archived-JD inside the edit modal. Keeps the modal compact by
  // default; tapping "Show" expands the full text for re-reading or editing.
  const descriptionToggle = $("field-description-toggle");
  if (descriptionToggle) {
    descriptionToggle.addEventListener("click", () => {
      const descEl = $("field-description");
      const emptyHint = $("field-description-empty");
      if (!descEl) return;
      const willShow = descEl.hidden;
      descEl.hidden = !willShow;
      if (emptyHint) emptyHint.hidden = !willShow || Boolean(descEl.value);
      descriptionToggle.textContent = willShow
        ? "Hide"
        : (descEl.value ? "Show" : "Add");
      if (willShow) descEl.focus();
    });
  }

  // ---------- Status timeline ----------

  function fmtTimelineDate(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const days = Math.round((Date.now() - t) / (24 * 3600 * 1000));
    const abs = new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    if (days <= 0) return `today · ${abs}`;
    if (days === 1) return `yesterday · ${abs}`;
    if (days < 30) return `${days}d ago · ${abs}`;
    if (days < 365) return `${Math.round(days / 30)}mo ago · ${abs}`;
    return `${Math.round(days / 365)}y ago · ${abs}`;
  }

  function timelineDuration(prevIso, nextIso) {
    const a = new Date(prevIso).getTime();
    const b = new Date(nextIso).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
    const days = Math.max(0, Math.round((b - a) / (24 * 3600 * 1000)));
    if (days === 0) return "same day";
    if (days === 1) return "1 day";
    if (days < 30) return `${days} days`;
    if (days < 365) return `${Math.round(days / 30)} mo`;
    return `${Math.round(days / 365)} yr`;
  }

  function renderStageTimeline(history) {
    const list = $("field-timeline-list");
    const empty = $("field-timeline-empty");
    if (!list) return;
    list.innerHTML = "";
    const items = Array.isArray(history) ? history : [];
    if (!items.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    items.forEach((entry, idx) => {
      const li = document.createElement("li");
      li.className = "timeline-item";
      const color = data.statusColor ? data.statusColor(entry.status) : "#0f766e";
      li.style.setProperty("--timeline-color", color);
      const dur = idx > 0 ? timelineDuration(items[idx - 1].at, entry.at) : "";
      li.innerHTML = `
        <span class="timeline-dot" style="background:${escapeHtml(color)}"></span>
        <div class="timeline-body">
          <div class="timeline-row-head">
            <span class="status-chip" style="background:${escapeHtml(color)}">${escapeHtml(data.statusLabel(entry.status))}</span>
            ${dur ? `<span class="timeline-dur">+${escapeHtml(dur)}</span>` : ""}
          </div>
          <div class="timeline-when">${escapeHtml(fmtTimelineDate(entry.at))}</div>
        </div>
      `;
      list.appendChild(li);
    });
  }

  const tlToggleBtn = $("field-timeline-toggle");
  if (tlToggleBtn) {
    tlToggleBtn.addEventListener("click", () => {
      const tlBody = $("field-timeline-body");
      if (!tlBody) return;
      const willShow = tlBody.hidden;
      tlBody.hidden = !willShow;
      tlToggleBtn.textContent = willShow ? "Hide" : "Show";
    });
  }

  const prepToggleBtn = $("field-prep-toggle");
  if (prepToggleBtn) {
    prepToggleBtn.addEventListener("click", () => {
      const prepBody = $("field-prep-body");
      if (!prepBody) return;
      const willShow = prepBody.hidden;
      prepBody.hidden = !willShow;
      prepToggleBtn.textContent = willShow ? "Hide" : "Add prep";
      if (willShow) {
        const firstInput = prepBody.querySelector("input, textarea");
        if (firstInput) firstInput.focus();
      }
    });
  }

  // Interview rounds: toggle, add a round, remove a round.
  const ivToggleBtn = $("field-interviews-toggle");
  if (ivToggleBtn) {
    ivToggleBtn.addEventListener("click", () => {
      const body = $("field-interviews-body");
      if (!body) return;
      const willShow = body.hidden;
      body.hidden = !willShow;
      const list = $("interviews-list");
      if (willShow && list && !list.children.length) list.insertAdjacentHTML("beforeend", interviewRowHtml({}));
      ivToggleBtn.textContent = willShow ? "Hide" : (list && list.children.length ? "Hide" : "Add interview");
      if (willShow && list) { const f = list.querySelector(".iv-label"); if (f) f.focus(); }
    });
  }
  const addInterviewBtn = $("add-interview-btn");
  if (addInterviewBtn) {
    addInterviewBtn.addEventListener("click", () => {
      const list = $("interviews-list");
      if (!list) return;
      list.insertAdjacentHTML("beforeend", interviewRowHtml({}));
      const f = list.lastElementChild && list.lastElementChild.querySelector(".iv-label");
      if (f) f.focus();
    });
  }
  const interviewsList = $("interviews-list");
  if (interviewsList) {
    interviewsList.addEventListener("click", (e) => {
      const rm = e.target.closest(".iv-remove");
      if (rm) { const row = rm.closest(".interview-round"); if (row) row.remove(); }
    });
  }

  jobForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      id: $("field-id").value || undefined,
      jobTitle: $("field-jobTitle").value.trim(),
      company: $("field-company").value.trim(),
      location: $("field-location").value.trim(),
      workMode: $("field-workMode").value,
      jobType: $("field-jobType").value,
      status: $("field-status").value,
      salary: $("field-salary").value.trim(),
      dateApplied: $("field-dateApplied").value,
      url: $("field-url").value.trim(),
      notes: $("field-notes").value.trim(),
      description: $("field-description") ? $("field-description").value : "",
      interviewPrep: {
        nextRound: $("field-prep-nextRound").value,
        scheduledAt: $("field-prep-scheduledAt").value,
        interviewers: $("field-prep-interviewers").value,
        questionsToAsk: $("field-prep-questionsToAsk").value,
        starStories: $("field-prep-starStories").value,
        notes: $("field-prep-notes").value
      },
      interviews: readInterviews()
    };

    const existing = payload.id && state.jobs.find((j) => j.id === payload.id);
    const nowIso = new Date().toISOString();
    const merged = Object.assign({}, existing || {}, payload, {
      createdAt: (existing && existing.createdAt) || undefined,
      updatedAt: nowIso
    });
    // Append a stage-history entry whenever the status actually changes so
    // the timeline grows through normal webapp edits, not just extension saves.
    merged.stageHistory = data.appendStageTransition(
      (existing && existing.stageHistory) || merged.stageHistory || [],
      merged.status,
      nowIso
    );
    const sanitized = data.sanitizeJob(merged);

    if (existing) {
      state.jobs = state.jobs.map((j) => (j.id === sanitized.id ? sanitized : j));
    } else {
      state.jobs.unshift(sanitized);
    }

    closeModal();
    renderJobs();
    const saveResult = await saveToDrive();
    if (!saveResult.ok) return;
    // Notify the extension content script (if present) that we just updated Drive.
    window.postMessage({ type: "JOBTRAIL_SYNC_REQUEST" }, "*");
    toast(saveResult.localOnly ? "Saved locally" : "Saved");
  });

  function persistDeletionToDrive(label) {
    saveToDrive()
      .then((saveResult) => {
        if (!saveResult.ok) return;
        window.postMessage({ type: "JOBTRAIL_SYNC_REQUEST" }, "*");
        toast(saveResult.localOnly ? `${label} locally` : label);
      })
      .catch((err) => {
        console.error("Delete sync failed:", err);
        toast("Delete saved locally, but Drive sync failed. Try Sync.", { error: true });
      });
  }

  function deleteJobById(id) {
    if (!id) return;
    const job = state.jobs.find((j) => j.id === id);
    const label = job && job.jobTitle ? ` "${job.jobTitle}"` : " this job";
    if (!confirm(`Delete${label}?`)) return;
    // Soft delete: mark tombstone so the deletion propagates to the extension
    // via Drive sync. Tombstones are purged after 30 days.
    const now = new Date().toISOString();
    state.jobs = state.jobs.map((j) =>
      j.id === id ? Object.assign({}, j, { deletedAt: now, updatedAt: now }) : j
    );
    if ($("field-id").value === id) closeModal();
    renderJobs();
    toast("Deleted");
    persistDeletionToDrive("Deleted");
  }

  jobDeleteBtn.addEventListener("click", () => {
    deleteJobById($("field-id").value);
  });

  function openJobForEdit(id) {
    const job = state.jobs.find((j) => j.id === id);
    if (job) openModal(job);
  }

  jobsTbody.addEventListener("click", (e) => {
    const deleteTarget = e.target.closest("[data-action='delete']");
    if (deleteTarget) {
      deleteJobById(deleteTarget.dataset.id);
      return;
    }
    // Don't hijack clicks on the "Open" link inside the row — that should
    // navigate to the job posting in a new tab, not open the edit modal.
    if (e.target.closest("[data-stop-row]")) return;
    const target = e.target.closest("[data-action='edit']");
    if (!target) return;
    openJobForEdit(target.dataset.id);
  });

  // Clicking an upcoming-interview entry jumps into that job's edit modal.
  if (funnelSection) {
    funnelSection.addEventListener("click", (e) => {
      const target = e.target.closest("[data-action='edit']");
      if (!target || !target.dataset.id) return;
      openJobForEdit(target.dataset.id);
    });
  }

  // Keyboard accessibility: Enter/Space on a focused row opens the edit modal.
  jobsTbody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest("tr.job-row");
    if (!row) return;
    e.preventDefault();
    openJobForEdit(row.dataset.id);
  });

  // ---------- Search / Filter ----------

  jobsSearch.addEventListener("input", () => renderJobs());
  jobsFilterStatus.addEventListener("change", () => renderJobs());
  const hideRejectedToggle = $("hide-rejected");
  if (hideRejectedToggle) {
    hideRejectedToggle.checked = hideRejected;
    hideRejectedToggle.addEventListener("change", () => {
      hideRejected = hideRejectedToggle.checked;
      try { localStorage.setItem("jobtrail_hide_rejected", hideRejected ? "1" : "0"); } catch (_) { /* ignore */ }
      renderJobs();
    });
  }
  const hideStaleToggle = $("hide-stale");
  if (hideStaleToggle) {
    hideStaleToggle.checked = hideStale;
    hideStaleToggle.addEventListener("change", () => {
      hideStale = hideStaleToggle.checked;
      try { localStorage.setItem("jobtrail_hide_stale", hideStale ? "1" : "0"); } catch (_) { /* ignore */ }
      renderJobs();
    });
  }
  const remoteOnlyToggle = $("remote-only");
  if (remoteOnlyToggle) {
    remoteOnlyToggle.checked = remoteOnly;
    remoteOnlyToggle.addEventListener("change", () => {
      remoteOnly = remoteOnlyToggle.checked;
      try { localStorage.setItem("jobtrail_remote_only", remoteOnly ? "1" : "0"); } catch (_) { /* ignore */ }
      renderJobs();
    });
  }
  const hideRestrictedToggle = $("hide-restricted");
  if (hideRestrictedToggle) {
    hideRestrictedToggle.checked = hideRestricted;
    hideRestrictedToggle.addEventListener("change", () => {
      hideRestricted = hideRestrictedToggle.checked;
      try { localStorage.setItem("jobtrail_hide_restricted", hideRestricted ? "1" : "0"); } catch (_) { /* ignore */ }
      renderJobs();
    });
  }
  // Inline status edits from the table.
  jobsTbody.addEventListener("change", (e) => {
    const sel = e.target.closest("select.row-status");
    if (sel) setJobStatusInline(sel.dataset.id, sel.value);
  });
  if (jobTypeTabs) {
    jobTypeTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-type-filter]");
      if (!btn) return;
      activeTypeFilter = btn.dataset.typeFilter || "all";
      renderJobs();
    });
  }
  addJobBtn.addEventListener("click", () => openModal(null));

  // ---------- Export / Import ----------

  exportBtn.addEventListener("click", () => {
    const payload = {
      schemaVersion: drive.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      jobs: state.jobs,
      profile: state.profile,
      autofillMappings: state.autofillMappings
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jobtrail-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener("click", () => importInput.click());

  importInput.addEventListener("change", async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const incoming = Array.isArray(parsed) ? parsed : parsed.jobs;
      if (!Array.isArray(incoming)) throw new Error("No jobs array found.");

      // Merge by id (incoming wins for collisions).
      const byId = new Map(state.jobs.map((j) => [j.id, j]));
      incoming.forEach((j) => {
        const san = data.sanitizeJob(j);
        byId.set(san.id, san);
      });
      state.jobs = Array.from(byId.values());

      if (parsed.profile && typeof parsed.profile === "object") {
        state.profile = parsed.profile;
      }
      if (parsed.autofillMappings && typeof parsed.autofillMappings === "object") {
        state.autofillMappings = parsed.autofillMappings;
      }

      renderJobs();
      const saveResult = await saveToDrive();
      if (!saveResult.ok) return;
      toast(`Imported ${incoming.length} job${incoming.length === 1 ? "" : "s"}`);
    } catch (err) {
      console.error(err);
      toast("Import failed: " + err.message, { error: true });
    }
  });

  // ---------- Sign in / out ----------

  async function signIn() {
    if (isExtensionRuntime) {
      signInBtn.disabled = true;
      try {
        const ok = await driveAuth.signIn();
        if (!ok) {
          toast("Sign-in cancelled", { error: true });
          return;
        }
        try { localStorage.setItem(SIGNED_IN_FLAG, "1"); } catch (_) {}
        showSignedIn();
        await loadFromDrive();
        renderJobs();
      } catch (err) {
        console.error(err);
        toast("Sign-in failed: " + err.message, { error: true });
      } finally {
        signInBtn.disabled = false;
      }
      return;
    }
    if (!hasValidClientId()) {
      configWarn.hidden = false;
      toast("Configure googleClientId in webapp/config.js first.", { error: true });
      return;
    }
    signInBtn.disabled = true;
    try {
      const tok = await requestToken({ interactive: true });
      if (!tok) {
        toast("Sign-in cancelled", { error: true });
        return;
      }
      try { localStorage.setItem(SIGNED_IN_FLAG, "1"); } catch (_) {}
      trackEvent("signin");
      showSignedIn();
      await loadFromDrive();
      renderJobs();
    } catch (err) {
      console.error(err);
      toast("Sign-in failed: " + err.message, { error: true });
    } finally {
      signInBtn.disabled = false;
    }
  }

  async function signOut() {
    try { localStorage.removeItem(SIGNED_IN_FLAG); } catch (_) {}
    if (isExtensionRuntime) {
      try { await driveAuth.signOut(); } catch (_) {}
      clearToken();
      await loadFromExtensionStorage();
      showExtensionLocalMode();
      setSync("", "Local only");
      renderJobs();
      return;
    }
    clearToken();
    state = { jobs: [], profile: null, autofillMappings: {}, loaded: false };
    showSignedOut();
  }

  async function attemptSilentRestore() {
    if (isExtensionRuntime) {
      try {
        await loadFromExtensionStorage();
        showExtensionLocalMode();
        renderJobs();
        const signedIn = await driveAuth.isSignedIn();
        if (!signedIn) {
          setSync("", "Local only");
          return;
        }
        setSync("syncing", "Restoring session…");
        showSignedIn();
        await loadFromDrive();
        renderJobs();
      } catch (err) {
        console.warn("Extension restore failed:", err);
        setSync("", "Not signed in");
      }
      return;
    }
    // On page load, if the user has signed in before on this device, try to
    // get a fresh token silently. Google will honor it as long as the user
    // hasn't revoked access and the browser still holds the consent cookie.
    let flag;
    try { flag = localStorage.getItem(SIGNED_IN_FLAG); } catch (_) { flag = null; }
    if (!flag || !hasValidClientId()) return;

    // Fast path: the previous session's token is still valid. Skip Google
    // entirely — this is what makes refreshes feel instant.
    const cached = readCachedToken();
    if (cached) {
      currentToken = cached.token;
      tokenExpiry = cached.expiry;
      setSync("syncing", "Restoring session…");
      try {
        showSignedIn();
        await loadFromDrive();
        renderJobs();
        return;
      } catch (err) {
        // Cached token may have been revoked server-side — fall through to
        // the silent-refresh path below, which will re-prompt if needed.
        console.warn("Cached-token restore failed, falling back to silent refresh:", err);
        clearCachedToken();
        currentToken = null;
        tokenExpiry = 0;
      }
    }

    const ready = await waitForGis(5000);
    if (!ready) return;

    setSync("syncing", "Restoring session…");
    const tok = await requestToken({ interactive: false });
    if (!tok) {
      // Silent refresh can fail (cookies cleared, consent revoked). Leave the
      // UI in its signed-out state so the user just clicks Sign in again.
      setSync("", "Not signed in");
      return;
    }
    try {
      showSignedIn();
      await loadFromDrive();
      renderJobs();
    } catch (err) {
      console.warn("Restore failed:", err);
      setSync("", "Not signed in");
    }
  }

  // Pull latest from Drive whenever the tab becomes visible so changes made
  // in the extension (or another device) show up the moment the user
  // switches back to the webapp. We listen on BOTH visibilitychange and
  // window.focus because Chrome dispatches them in different orders
  // depending on how the tab was activated. A short 2 s cooldown prevents
  // thrashing if both fire back-to-back. We also schedule a follow-up pull
  // ~3 s later so writes from the other surface that hadn't landed yet still
  // get caught on this visit.
  let lastVisiblePullAt = 0;
  const VISIBLE_PULL_COOLDOWN_MS = 2000;
  const BACKGROUND_PULL_INTERVAL_MS = 15000;
  let followupPullTimer = null;

  // Don't pull-and-overwrite when:
  //   - a save is currently in flight (it'd race and revert our just-edited
  //     state back to Drive's old content),
  //   - a save failed recently (the user's local edits are unsaved-but-real;
  //     overwriting them with Drive's stale state silently loses the edit).
  // The dashboard / extension still propagates eventually via sync — what we
  // protect here is the user's in-tab edits.
  function profileEditorOpen() {
    const modal = document.getElementById("profile-modal");
    return !!(modal && !modal.hidden);
  }

  function pullSuppressed() {
    if (profileEditorOpen()) return true;
    if (saveInFlight) return true;
    if (lastSaveFailedAt && Date.now() - lastSaveFailedAt < FAILED_SAVE_GUARD_MS) return true;
    return false;
  }

  async function pullFromDriveIfDue() {
    if (!state.loaded) return;
    if (state.demo) return; // demo is sandboxed — never touch Drive / auth
    if (pullSuppressed()) return;
    if (isExtensionRuntime) {
      const signedIn = await driveAuth.isSignedIn();
      if (!signedIn) return;
    }
    if (Date.now() - lastVisiblePullAt < VISIBLE_PULL_COOLDOWN_MS) return;
    lastVisiblePullAt = Date.now();
    try {
      await loadFromDrive({ silent: true });
      renderJobs();
    } catch (err) {
      console.warn("Visibility pull failed:", err);
    }
  }
  function scheduleFollowupPull() {
    if (followupPullTimer) clearTimeout(followupPullTimer);
    followupPullTimer = setTimeout(async () => {
      followupPullTimer = null;
      if (!state.loaded) return;
      if (state.demo) return;
      if (pullSuppressed()) return;
      if (isExtensionRuntime) {
        const signedIn = await driveAuth.isSignedIn();
        if (!signedIn) return;
      }
      try {
        await loadFromDrive({ silent: true });
        renderJobs();
      } catch (err) { /* ignore */ }
    }, 3000);
  }
  function onWebappActivate() {
    if (document.hidden) return;
    pullFromDriveIfDue();
    scheduleFollowupPull();
  }
  document.addEventListener("visibilitychange", onWebappActivate);
  window.addEventListener("focus", onWebappActivate);
  window.setInterval(() => {
    if (document.hidden) return;
    pullFromDriveIfDue();
  }, BACKGROUND_PULL_INTERVAL_MS);
  if (isExtensionRuntime && window.chrome && chrome.storage && chrome.storage.onChanged) {
    let extensionReloadTimer = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" && area !== "sync") return;
      if (!(changes[data.STORAGE_KEY] || changes[data.PROFILE_KEY] || changes[data.AUTOFILL_MAPPINGS_KEY])) return;
      if (profileEditorOpen()) return;
      if (extensionReloadTimer) clearTimeout(extensionReloadTimer);
      extensionReloadTimer = setTimeout(async () => {
        extensionReloadTimer = null;
        try {
          await loadFromExtensionStorage();
          renderJobs();
        } catch (_) { /* ignore */ }
      }, 120);
    });
  }

  function showSignedIn() {
    signedOutCard.hidden = true;
    statsRow.hidden = false;
    if (viewTabs) viewTabs.hidden = false;
    signInBtn.hidden = true;
    signOutBtn.hidden = false;
    if (profileBtn) profileBtn.hidden = false;
    if (refreshBtn) refreshBtn.hidden = false;
    exportBtn.disabled = false;
    importBtn.disabled = false;
    cachedUserEmail = null; // re-check identity for the owner-only analytics tab
    maybeRevealAnalyticsTab();
    setView(currentView);
    refreshSavedSearchCounts();
  }

  function showExtensionLocalMode() {
    signedOutCard.hidden = true;
    statsRow.hidden = false;
    if (viewTabs) viewTabs.hidden = false;
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
    if (profileBtn) profileBtn.hidden = false;
    if (refreshBtn) refreshBtn.hidden = false;
    exportBtn.disabled = false;
    importBtn.disabled = false;
    setView(currentView);
    refreshSavedSearchCounts();
  }

  function showSignedOut() {
    signedOutCard.hidden = false;
    if (demoBanner) demoBanner.hidden = true;
    statsRow.hidden = true;
    if (viewTabs) viewTabs.hidden = true;
    funnelSection.hidden = true;
    jobsSection.hidden = true;
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
    if (profileBtn) profileBtn.hidden = true;
    if (refreshBtn) refreshBtn.hidden = true;
    exportBtn.disabled = true;
    importBtn.disabled = true;
    cachedUserEmail = null;
    const anTab = $("analytics-tab");
    if (anTab) anTab.hidden = true;
    setSync("", "Not signed in");
  }

  // ---------- Demo mode (no auth — for portfolio visitors) ----------

  function demoDate(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }

  function buildDemoJobs() {
    const seed = [
      { jobTitle: "Senior Product Engineer", company: "Linear", location: "Remote (EU)", workMode: "Remote", jobType: "full-time", status: "interviewing", dateApplied: demoDate(9), url: "https://linear.app/careers", description: "Build delightful, fast product experiences across the Linear app.", aiFitAnalysis: { score: 88 } },
      { jobTitle: "Founding AI Engineer", company: "ElevenLabs", location: "London, UK", workMode: "Hybrid", jobType: "full-time", status: "applied", dateApplied: demoDate(5), url: "https://elevenlabs.io/careers", aiFitAnalysis: { score: 82 } },
      { jobTitle: "Forward Deployed Engineer", company: "Ramp", location: "Remote", workMode: "Remote", jobType: "full-time", status: "offer", dateApplied: demoDate(21), description: "Work directly with customers to deploy and tailor the platform." },
      { jobTitle: "Solutions Engineer", company: "Vercel", location: "London, UK", workMode: "Hybrid", jobType: "full-time", status: "interviewing", dateApplied: demoDate(12) },
      { jobTitle: "Product Manager, AI", company: "Notion", location: "Remote (UK)", workMode: "Remote", jobType: "full-time", status: "applied", dateApplied: demoDate(3) },
      { jobTitle: "Full-Stack Engineer", company: "Stickermule", location: "Remote", workMode: "Remote", jobType: "full-time", status: "bookmarked", dateApplied: "" },
      { jobTitle: "Developer Advocate", company: "Supabase", location: "Remote", workMode: "Remote", jobType: "contract", status: "rejected", dateApplied: demoDate(28) },
      { jobTitle: "Applied AI Engineer", company: "Perplexity", location: "London, UK", workMode: "On-site", jobType: "full-time", status: "applying", dateApplied: "" }
    ];
    return seed.map((j, i) => data.sanitizeJob(Object.assign({
      id: "demo_" + i,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, j)));
  }

  function loadDemo() {
    state = { jobs: buildDemoJobs(), profile: null, autofillMappings: {}, loaded: true, demo: true };
    signedOutCard.hidden = true;
    if (demoBanner) demoBanner.hidden = false;
    statsRow.hidden = false;
    if (viewTabs) viewTabs.hidden = false;
    signInBtn.hidden = true;
    signOutBtn.hidden = true;
    if (profileBtn) profileBtn.hidden = false;
    if (refreshBtn) refreshBtn.hidden = true;
    exportBtn.disabled = false;
    importBtn.disabled = true;
    setSync("", "Demo");
    setView(currentView);
    renderJobs(); // setView only toggles visibility — this paints the data
    toast("Loaded sample data — explore freely");
  }

  function exitDemo() {
    state = { jobs: [], profile: null, autofillMappings: {}, loaded: false, demo: false };
    renderJobs();
    showSignedOut();
  }

  async function manualRefresh() {
    if (state.demo || !state.loaded) return;
    if (isExtensionRuntime && driveAuth) {
      const ok = await driveAuth.isSignedIn().catch(() => false);
      if (!ok) { toast("Sign in to sync from Drive", { error: true }); return; }
    }
    if (refreshBtn) refreshBtn.disabled = true;
    setSync("syncing", "Refreshing…");
    try {
      await loadFromDrive();
      renderJobs();
      toast("Up to date");
    } catch (err) {
      setSync("signed-in", "Sync failed — retry");
      toast("Refresh failed: " + (err && err.message ? err.message : "network error"), { error: true });
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }
  if (refreshBtn) refreshBtn.addEventListener("click", manualRefresh);
  // Keep the "Synced · Nm ago" label fresh without re-pulling.
  setInterval(updateSyncedLabel, 30000);

  signInBtn.addEventListener("click", signIn);
  signOutBtn.addEventListener("click", signOut);

  // Demo + hero buttons
  const demoBtn = $("demo-button");
  const signInBtn2 = $("signin-button-2");
  const demoSignInBtn = $("demo-signin-button");
  const demoExitBtn = $("demo-exit-button");
  const addFirstJobBtn = $("add-first-job");
  if (demoBtn) demoBtn.addEventListener("click", loadDemo);
  if (signInBtn2) signInBtn2.addEventListener("click", signIn);
  if (demoSignInBtn) demoSignInBtn.addEventListener("click", () => { state.demo = false; signIn(); });
  if (demoExitBtn) demoExitBtn.addEventListener("click", exitDemo);
  if (addFirstJobBtn) addFirstJobBtn.addEventListener("click", () => openModal(null));

  // ---------- Site analytics (visitor dashboard) ----------
  //
  // A privacy-light beacon POSTs to /api/track on each page view (and on
  // sign-in). The "Site analytics" tab is superuser-only: it appears, and
  // /api/stats authorizes, only for OWNER_EMAIL — verified SERVER-side from the
  // signed-in Google token (no separate password). No backend = no data, so
  // this no-ops where the functions don't exist (extension, file://).
  const OWNER_EMAIL = "haruki.kimura.jp@gmail.com";
  const VISITOR_ID_KEY = "jobtrail_vid";
  let cachedUserEmail = null;
  let lastVisitors = [];

  function analyticsHostable() {
    return !isExtensionRuntime && /^https?:$/.test(location.protocol);
  }
  // Drive's `about` endpoint returns the signed-in user's email even with just
  // the drive scope — so we identify the owner without any extra OAuth scope.
  async function fetchUserEmail() {
    if (cachedUserEmail !== null) return cachedUserEmail;
    cachedUserEmail = "";
    try {
      const token = await tokenProvider();
      if (!token) return cachedUserEmail;
      const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", { headers: { Authorization: "Bearer " + token } });
      if (res.ok) { const j = await res.json(); cachedUserEmail = (j.user && j.user.emailAddress) || ""; }
    } catch (_) { /* leave empty */ }
    return cachedUserEmail;
  }
  function visitorId() {
    try {
      let v = localStorage.getItem(VISITOR_ID_KEY);
      if (!v) {
        v = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + "-" + Math.random().toString(36).slice(2));
        localStorage.setItem(VISITOR_ID_KEY, v);
      }
      return v;
    } catch (_) { return ""; }
  }
  function trackEvent(type) {
    if (!analyticsHostable()) return;
    let tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) { /* ignore */ }
    try {
      fetch("/api/track", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          path: location.pathname,
          ref: document.referrer,
          sid: visitorId(),
          lang: (navigator.language || "").slice(0, 12),
          tz: tz.slice(0, 40)
        }),
        keepalive: true
      }).catch(() => {});
    } catch (_) { /* never let tracking affect the page */ }
  }

  async function maybeRevealAnalyticsTab() {
    const tab = $("analytics-tab");
    if (!tab || !analyticsHostable()) return;
    const email = await fetchUserEmail();
    tab.hidden = !(email && email.toLowerCase() === OWNER_EMAIL.toLowerCase());
  }

  function renderAnalyticsData(d) {
    const t = (d && d.totals) || {};
    const num = (n) => Number(n || 0).toLocaleString();
    const set = (id, n) => { const el = $(id); if (el) el.textContent = num(n); };
    set("an-visitors", t.visitors);
    set("an-pageviews", t.pageviews);
    set("an-signins", t.signins);
    set("an-signed-visitors", t.signedInVisitors);

    const bars = $("an-bars");
    if (bars) {
      const days = (d && d.byDay) || [];
      const max = Math.max(1, ...days.map((x) => x.pageviews || 0));
      bars.innerHTML = days.length
        ? days.map((x) => {
            const h = Math.max(2, Math.round(((x.pageviews || 0) / max) * 100));
            return `<div class="an-bar" title="${escapeHtml(x.day)} · ${x.pageviews} views · ${x.visitors} visitors · ${x.signins} sign-ins"><span class="an-bar-fill" style="height:${h}%"></span></div>`;
          }).join("")
        : '<p class="muted">No visits in this range yet.</p>';
    }
    const list = (id, rows, keyName) => {
      const el = $(id); if (!el) return;
      el.innerHTML = (rows && rows.length)
        ? rows.map((r) => `<li><span>${escapeHtml(String(r[keyName] || "—"))}</span><strong>${num(r.count)}</strong></li>`).join("")
        : '<li class="muted">No data yet.</li>';
    };
    list("an-referrers", d && d.topReferrers, "name");
    list("an-countries", d && d.topCountries, "code");
    list("an-paths", d && d.topPaths, "path");
    const dev = (d && d.devices) || { mobile: 0, desktop: 0 };
    const devEl = $("an-devices");
    if (devEl) devEl.innerHTML = `<li><span>Desktop</span><strong>${num(dev.desktop)}</strong></li><li><span>Mobile</span><strong>${num(dev.mobile)}</strong></li>`;

    lastVisitors = (d && d.visitors) || [];
    renderVisitorRows();
  }

  function analyticsTimeAgo(iso) {
    const t = new Date(iso).getTime();
    if (!t) return "";
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function renderVisitorRows() {
    const tbody = $("an-visitor-rows");
    if (!tbody) return;
    const hide = $("an-hide-signins") && $("an-hide-signins").checked;
    const rows = (lastVisitors || []).filter((v) => !(hide && v.signedIn));
    const count = $("an-visitor-count");
    if (count) count.textContent = rows.length ? "· " + rows.length : "";
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">No visitors in this range yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((v) => {
      const sid = String(v.sid || "");
      const sidShort = "v_" + sid.replace(/^v_/, "").slice(0, 4) + "…" + sid.slice(-4);
      const loc = [v.country, v.city].filter(Boolean).join(" · ") || v.tz || "—";
      const dev = (v.device && v.device !== "unknown") ? v.device : "—";
      const src = (v.source && v.source !== "direct") ? v.source : "Direct";
      const me = v.signedIn ? '<span class="an-badge">you</span>' : "";
      return `<tr${v.signedIn ? ' class="an-row-me"' : ""}>
        <td class="an-sid">${escapeHtml(sidShort)}${me}</td>
        <td title="${escapeHtml(new Date(v.lastSeen).toLocaleString())}">${escapeHtml(analyticsTimeAgo(v.lastSeen))}</td>
        <td>${escapeHtml(loc)}</td>
        <td>${escapeHtml(dev)}</td>
        <td>${escapeHtml(v.lang || "—")}</td>
        <td class="an-src" title="${escapeHtml(src)}">${escapeHtml(src)}</td>
        <td class="an-num">${Number(v.visits || 0).toLocaleString()}</td>
      </tr>`;
    }).join("");
  }

  async function renderAnalytics() {
    const status = $("analytics-status");
    const days = ($("analytics-range") && $("analytics-range").value) || "30";
    if (status) status.textContent = "Loading…";
    try {
      const token = await tokenProvider();
      if (!token) { if (status) status.textContent = "Sign in as the site owner to view analytics."; return; }
      const res = await fetch("/api/stats?days=" + encodeURIComponent(days), { headers: { Authorization: "Bearer " + token } });
      if (res.status === 403) { if (status) status.textContent = "Only the site owner can view analytics."; return; }
      if (!res.ok) { if (status) status.textContent = "Couldn't load analytics (HTTP " + res.status + ")."; return; }
      const data = await res.json();
      renderAnalyticsData(data);
      if (status) status.textContent = "Updated " + new Date().toLocaleString() + " · last " + (data.rangeDays || days) + " days";
    } catch (_) {
      if (status) status.textContent = "Analytics unavailable — the site must be deployed on Netlify with the functions enabled.";
    }
  }

  if ($("analytics-range")) $("analytics-range").addEventListener("change", renderAnalytics);
  if ($("an-hide-signins")) $("an-hide-signins").addEventListener("change", renderVisitorRows);

  // ---------- Boot ----------

  drive.setTokenProvider(isExtensionRuntime && driveAuth ? driveAuth.tokenProvider : tokenProvider);
  populateStatusSelects();
  showSignedOut();
  trackEvent("pageview");

  if (!isExtensionRuntime && !hasValidClientId()) {
    configWarn.hidden = false;
  }

  // Try to silently pick up an existing session so refreshing the page doesn't
  // boot the user back to the sign-in screen.
  attemptSilentRestore();

  // ---------- Profile drawer (classification + AI settings) ----------

  const profileModal = $("profile-modal");
  const profileForm = $("profile-form");
  const sectionTabs = $("section-tabs");

  // The section the profile editor is currently showing. Not necessarily the
  // profile's activeSectionId until the user hits Save.
  let editingSectionId = null;

  const COMMON_PROFILE_INPUTS = [
    "firstName", "lastName", "email", "phone",
    "city", "country", "currentCompany", "currentTitle",
    "linkedinUrl", "githubUrl", "portfolioUrl"
  ];
  const SECTION_PROFILE_INPUTS = [
    "yearsExperience", "desiredSalary", "workAuthorization",
    "noticePeriod", "preferredStartDate", "resumeText"
  ];

  function ensureProfileLoaded() {
    if (!state.profile) {
      // sanitizeProfile fills in defaults including all three sections.
      state.profile = data.sanitizeProfile({});
    }
    return state.profile;
  }

  function renderSectionTabs() {
    const p = ensureProfileLoaded();
    if (!editingSectionId) editingSectionId = p.activeSectionId;
    sectionTabs.innerHTML = (p.sections || []).map((s) => `
      <button type="button"
              class="section-tab ${s.id === editingSectionId ? "is-active" : ""} ${s.id === p.activeSectionId ? "is-current" : ""}"
              data-section-id="${escapeHtml(s.id)}">
        ${escapeHtml(s.name)}${s.id === p.activeSectionId ? ' <span class="section-tab-badge">active</span>' : ""}
      </button>
    `).join("") + `
      <button type="button" class="section-set-active" id="section-set-active-btn" ${editingSectionId === p.activeSectionId ? "hidden" : ""}>
        Use this section
      </button>
    `;
  }

  function readProfileFormIntoState() {
    const p = ensureProfileLoaded();
    COMMON_PROFILE_INPUTS.forEach((key) => {
      p[key] = ($("profile-" + key).value || "").trim();
    });
    // fullName is derived; re-compute on save so it stays consistent.
    p.fullName = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();

    const section = p.sections.find((s) => s.id === editingSectionId) || p.sections[0];
    SECTION_PROFILE_INPUTS.forEach((key) => {
      section[key] = ($("profile-" + key).value || "").trim();
    });

    p.ai = data.sanitizeAiSettings({
      provider: $("profile-ai-provider").value,
      apiKey: $("profile-ai-apiKey").value,
      model: $("profile-ai-model").value
    });
  }

  function syncSavedAnswersFromDom() {
    if (!qaListEl) return;
    const section = getEditingSection();
    if (!section || !Array.isArray(section.customAnswers)) return;
    qaListEl.querySelectorAll(".qa-row").forEach((row) => {
      const id = row.dataset.qaId;
      const qa = section.customAnswers.find((item) => item.id === id);
      if (!qa) return;
      const qInput = row.querySelector(".qa-question");
      const aInput = row.querySelector(".qa-answer");
      qa.question = qInput ? qInput.value : qa.question;
      qa.answer = aInput ? aInput.value : qa.answer;
      if (qa.source === "captured") {
        qa.source = "manual";
        qa.capturedAt = "";
      }
    });
  }

  function writeSectionFieldsFromState() {
    const p = ensureProfileLoaded();
    const section = p.sections.find((s) => s.id === editingSectionId) || p.sections[0];
    SECTION_PROFILE_INPUTS.forEach((key) => {
      $("profile-" + key).value = section[key] || "";
    });
    renderResumeFileControl(section);
    renderSavedAnswers();
  }

  function renderResumeFileControl(section) {
    const input = $("profile-resumeFile");
    const label = $("profile-resumeFile-name");
    const removeBtn = $("profile-resumeFile-remove");
    if (input) input.value = "";
    const file = section && section.resumeFile;
    if (label) {
      label.textContent = file && file.name
        ? `Stored CV: ${file.name}${file.size ? ` · ${Math.round(file.size / 1024)} KB` : ""}`
        : "No file selected.";
      label.classList.toggle("has-file", !!(file && file.name));
    }
    if (removeBtn) removeBtn.disabled = !(file && file.name);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size || 0,
        dataUrl: String(reader.result || "")
      });
      reader.onerror = () => reject(reader.error || new Error("Could not read file."));
      reader.readAsDataURL(file);
    });
  }

  // ---- CV text extraction (PDF / plain text) -------------------------------
  //
  // Populates the "CV / resume (plain text)" box that AI cover-letter and
  // autofill answers read from. pdf.js is bundled locally (vendor/) so this
  // works offline with no backend; it's ~0.3 MB and loaded on first use only.
  let pdfjsLibPromise = null;
  function loadPdfJs() {
    if (!pdfjsLibPromise) {
      pdfjsLibPromise = import("./vendor/pdf.min.mjs").then((lib) => {
        try {
          lib.GlobalWorkerOptions.workerSrc =
            new URL("./vendor/pdf.worker.min.mjs", document.baseURI).href;
        } catch (_) {
          lib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";
        }
        return lib;
      });
    }
    return pdfjsLibPromise;
  }

  async function extractTextFromPdf(arrayBuffer) {
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pageCount = Math.min(pdf.numPages, 30);
    const pages = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => (it && it.str) || "").join(" "));
      if (typeof page.cleanup === "function") page.cleanup();
    }
    return pages.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function extractResumeText(file) {
    const name = String((file && file.name) || "").toLowerCase();
    const type = String((file && file.type) || "");
    if (type === "application/pdf" || name.endsWith(".pdf")) {
      return extractTextFromPdf(await file.arrayBuffer());
    }
    if (type.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md")) {
      return String((await file.text()) || "").trim();
    }
    // .doc/.docx/.rtf need a heavier dependency to parse — not auto-extracted.
    return "";
  }

  // After a CV file is attached, pull its text into the resume box so AI
  // features have something to work from. Never overwrites text the user
  // typed/pasted themselves.
  async function maybeExtractResumeText(file, section) {
    const resumeTextEl = $("profile-resumeText");
    if (resumeTextEl && resumeTextEl.value.trim().length > 0) return;
    const label = $("profile-resumeFile-name");
    try {
      if (label) label.textContent = `Reading text from ${file.name}…`;
      const clean = String((await extractResumeText(file)) || "").trim().slice(0, 20000);
      if (clean) {
        if (resumeTextEl) resumeTextEl.value = clean;
        if (section) section.resumeText = clean;
        toast("CV text extracted — review it in the box below");
      } else {
        toast("Couldn't read text from this file type — paste your CV below.", { error: true });
      }
    } catch (_) {
      toast("Couldn't read this PDF — paste your CV text below.", { error: true });
    } finally {
      renderResumeFileControl(section);
    }
  }

  // ---------- Saved answers (per-section custom Q&A library) ----------
  //
  // The list is the same shape as the extension dashboard's. The webapp adds:
  //   • search filter (helps once captures pile up)
  //   • a "captured" badge on auto-saved rows so the user can audit them
  // Edits/adds/deletes mutate state.profile in place; the parent profile
  // form's submit handler persists everything to Drive in one write.
  const qaListEl = $("qa-list");
  const qaSearchEl = $("qa-search");
  const qaAddBtn = $("qa-add");
  const qaEmptyHint = $("qa-empty-hint");
  let qaSearchTerm = "";

  function getEditingSection() {
    const p = ensureProfileLoaded();
    return p.sections.find((s) => s.id === editingSectionId) || p.sections[0];
  }

  function fmtCapturedAt(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const days = Math.round((Date.now() - t) / (24 * 3600 * 1000));
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.round(days / 30)}mo ago`;
    return `${Math.round(days / 365)}y ago`;
  }

  function renderSavedAnswers() {
    if (!qaListEl) return;
    const section = getEditingSection();
    if (!section) {
      qaListEl.innerHTML = "";
      if (qaEmptyHint) qaEmptyHint.hidden = false;
      return;
    }
    if (!Array.isArray(section.customAnswers)) section.customAnswers = [];
    const all = section.customAnswers;
    const term = qaSearchTerm.trim().toLowerCase();
    const visible = term
      ? all.filter((qa) =>
          qa.question.toLowerCase().includes(term) ||
          qa.answer.toLowerCase().includes(term))
      : all;

    if (qaEmptyHint) qaEmptyHint.hidden = all.length > 0;

    qaListEl.innerHTML = visible.map((qa) => `
      <div class="qa-row" data-qa-id="${escapeHtml(qa.id)}">
        <div class="qa-row-fields">
          <div class="qa-row-meta">
            ${qa.source === "captured"
              ? `<span class="qa-tag qa-tag-captured" title="Auto-captured during autofill ${escapeHtml(fmtCapturedAt(qa.capturedAt))}">captured · ${escapeHtml(fmtCapturedAt(qa.capturedAt))}</span>`
              : '<span class="qa-tag qa-tag-manual">manual</span>'}
          </div>
          <input type="text" class="qa-question" placeholder="Form question" value="${escapeHtml(qa.question)}">
          <textarea class="qa-answer" rows="2" placeholder="Your answer">${escapeHtml(qa.answer)}</textarea>
        </div>
        <button type="button" class="qa-row-remove" aria-label="Remove answer">Remove</button>
      </div>
    `).join("") || (term
      ? '<div class="qa-empty">No answers match your search.</div>'
      : "");

    qaListEl.querySelectorAll(".qa-row").forEach((row) => {
      const id = row.dataset.qaId;
      const qa = section.customAnswers.find((item) => item.id === id);
      if (!qa) return;
      const qInput = row.querySelector(".qa-question");
      const aInput = row.querySelector(".qa-answer");
      const removeBtn = row.querySelector(".qa-row-remove");
      // Editing a captured answer promotes it to manual (the user's curating
      // it now), so it stops surfacing the auto-captured pill on next render.
      const promoteOnEdit = () => {
        if (qa.source === "captured") {
          qa.source = "manual";
          qa.capturedAt = "";
        }
      };
      qInput.addEventListener("input", () => { qa.question = qInput.value; promoteOnEdit(); });
      aInput.addEventListener("input", () => { qa.answer = aInput.value; promoteOnEdit(); });
      removeBtn.addEventListener("click", () => {
        section.customAnswers = section.customAnswers.filter((item) => item.id !== id);
        renderSavedAnswers();
      });
    });
  }

  if (qaSearchEl) {
    qaSearchEl.addEventListener("input", () => {
      qaSearchTerm = qaSearchEl.value || "";
      renderSavedAnswers();
    });
  }

  if (qaAddBtn) {
    qaAddBtn.addEventListener("click", () => {
      const section = getEditingSection();
      if (!section) return;
      if (!Array.isArray(section.customAnswers)) section.customAnswers = [];
      section.customAnswers.push({
        id: "qa_" + Math.random().toString(36).slice(2, 10),
        question: "",
        answer: "",
        source: "manual",
        capturedAt: ""
      });
      qaSearchTerm = "";
      if (qaSearchEl) qaSearchEl.value = "";
      renderSavedAnswers();
      const rows = qaListEl.querySelectorAll(".qa-row");
      const last = rows[rows.length - 1];
      if (last) last.querySelector(".qa-question").focus();
    });
  }

  const resumeFileInput = $("profile-resumeFile");
  let resumeFileReadPromise = null;
  if (resumeFileInput) {
    resumeFileInput.addEventListener("change", async () => {
      const section = getEditingSection();
      const file = resumeFileInput.files && resumeFileInput.files[0];
      if (!section || !file) return;
      try {
        const label = $("profile-resumeFile-name");
        if (label) {
          label.textContent = `Reading CV: ${file.name}${file.size ? ` · ${Math.round(file.size / 1024)} KB` : ""}`;
          label.classList.add("has-file");
        }
        const pendingRead = readFileAsDataUrl(file);
        resumeFileReadPromise = pendingRead;
        section.resumeFile = await pendingRead;
        if (resumeFileReadPromise === pendingRead) resumeFileReadPromise = null;
        renderResumeFileControl(section);
        toast("CV file attached to this profile section");
        await maybeExtractResumeText(file, section);
      } catch (error) {
        resumeFileReadPromise = null;
        renderResumeFileControl(section);
        toast(error && error.message ? error.message : "Could not attach CV file.", { error: true });
      }
    });
  }

  const resumeFileRemove = $("profile-resumeFile-remove");
  if (resumeFileRemove) {
    resumeFileRemove.addEventListener("click", () => {
      const section = getEditingSection();
      if (!section) return;
      section.resumeFile = null;
      renderResumeFileControl(section);
    });
  }

  function openProfileModal() {
    const p = ensureProfileLoaded();
    editingSectionId = p.activeSectionId;

    COMMON_PROFILE_INPUTS.forEach((key) => {
      $("profile-" + key).value = p[key] || "";
    });
    writeSectionFieldsFromState();

    const ai = p.ai || { provider: "none", apiKey: "", model: "" };
    $("profile-ai-provider").value = ai.provider || "none";
    $("profile-ai-apiKey").value = ai.apiKey || "";
    $("profile-ai-model").value = ai.model || (data.AI_DEFAULT_MODEL[ai.provider] || "");

    renderSectionTabs();
    profileModal.hidden = false;
  }

  function closeProfileModal() {
    profileModal.hidden = true;
  }

  if (profileBtn) profileBtn.addEventListener("click", openProfileModal);
  if (profileModal) {
    profileModal.addEventListener("click", (e) => {
      if (e.target && e.target.matches("[data-close-profile]")) closeProfileModal();
    });
  }

  if (sectionTabs) {
    sectionTabs.addEventListener("click", (e) => {
      const setActiveBtn = e.target.closest("#section-set-active-btn");
      if (setActiveBtn) {
        // Promote the section currently being edited to activeSectionId.
        // Persists on form Save, so the badge flips immediately for visual
        // feedback but the Drive write happens with the rest of the profile.
        const p = ensureProfileLoaded();
        p.activeSectionId = editingSectionId;
        renderSectionTabs();
        return;
      }
      const tab = e.target.closest(".section-tab");
      if (!tab) return;
      // Save the currently-edited section's fields before switching, so
      // typing into Full-time and then clicking Part-time doesn't lose work.
      readProfileFormIntoState();
      editingSectionId = tab.dataset.sectionId;
      writeSectionFieldsFromState();
      renderSectionTabs();
    });
  }

  // Default the AI model when the user changes provider.
  const aiProviderEl = $("profile-ai-provider");
  if (aiProviderEl) {
    aiProviderEl.addEventListener("change", () => {
      const provider = aiProviderEl.value;
      const defaultModel = data.AI_DEFAULT_MODEL[provider] || "";
      // Only overwrite if the user hasn't set a custom one for this provider.
      const current = ($("profile-ai-model").value || "").trim();
      const legacyDefaults = ["deepseek-chat"];
      const anyDefault = Object.values(data.AI_DEFAULT_MODEL).includes(current) || legacyDefaults.includes(current);
      if (!current || anyDefault) $("profile-ai-model").value = defaultModel;
    });
  }

  if (profileForm) {
    profileForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (resumeFileReadPromise) {
        try {
          const fileInfo = await resumeFileReadPromise;
          const section = getEditingSection();
          if (section && fileInfo) {
            section.resumeFile = fileInfo;
            renderResumeFileControl(section);
          }
        } catch (_) { /* surfaced in change handler */ }
        resumeFileReadPromise = null;
      }
      syncSavedAnswersFromDom();
      readProfileFormIntoState();
      state.profile = data.sanitizeProfile(state.profile);
      closeProfileModal();
      const saveResult = await saveToDrive();
      if (!saveResult.ok) return;
      // Notify the extension content script (if present) that we just updated Drive.
      window.postMessage({ type: "JOBTRAIL_SYNC_REQUEST" }, "*");
      const activeSection = data.findActiveSection(state.profile);
      const fileSuffix = activeSection && activeSection.resumeFile ? " · CV stored" : "";
      toast(saveResult.localOnly ? `Profile saved locally${fileSuffix}` : `Profile saved${fileSuffix}`);
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !profileModal.hidden) closeProfileModal();
  });

  // ---------- AI cover letter (inside the job modal) ----------

  const aiCoverBody = $("ai-cover-body");
  const aiCoverToggle = $("ai-cover-toggle");
  const aiCoverText = $("ai-cover-text");
  const aiCoverGenBtn = $("ai-cover-generate");
  const aiCoverCopyBtn = $("ai-cover-copy");
  const aiCoverStatus = $("ai-cover-status");
  const aiCoverHint = $("ai-cover-hint");

  function setAiStatus(label) {
    if (aiCoverStatus) aiCoverStatus.textContent = label || "";
  }

  function currentJobFromForm() {
    const id = $("field-id").value;
    if (!id) return null;
    return state.jobs.find((j) => j.id === id) || null;
  }

  function collectCoverLetterInputs() {
    const p = ensureProfileLoaded();
    const section = (p.sections || []).find((s) => s.id === p.activeSectionId) || (p.sections || [])[0] || {};
    const cv = (section.resumeText || "").trim();
    const role = ($("field-jobTitle").value || "").trim();
    const company = ($("field-company").value || "").trim();
    const jd = ($("field-description") ? $("field-description").value : "").trim();
    return { cv, role, company, jd, section, profile: p };
  }

  function loadCachedCoverLetterIntoModal(job) {
    // When opening a job, if we have a cached letter whose input hash still
    // matches the current CV + description + role + company, show it instead
    // of regenerating. Cheap and keeps the user's edits intact across opens.
    if (!aiCoverText) return;
    aiCoverText.value = "";
    setAiStatus("");
    if (!job || !job.aiCoverLetter) return;

    const inputs = collectCoverLetterInputs();
    const freshHash = data.hashCoverLetterInputs({
      cv: inputs.cv, jd: inputs.jd, role: inputs.role, company: inputs.company
    });

    aiCoverText.value = job.aiCoverLetter.text || "";
    if (job.aiCoverLetter.inputsHash === freshHash) {
      setAiStatus(`Cached · ${job.aiCoverLetter.model || job.aiCoverLetter.provider || "AI"}`);
    } else {
      setAiStatus("Cached · inputs changed");
    }
  }

  if (aiCoverToggle) {
    aiCoverToggle.addEventListener("click", () => {
      if (!aiCoverBody) return;
      const willShow = aiCoverBody.hidden;
      aiCoverBody.hidden = !willShow;
      aiCoverToggle.textContent = willShow ? "Hide" : "Show";
      if (willShow && aiCoverText && !aiCoverText.value) {
        const job = currentJobFromForm();
        if (job) loadCachedCoverLetterIntoModal(job);
      }
    });
  }

  if (aiCoverCopyBtn) {
    aiCoverCopyBtn.addEventListener("click", async () => {
      if (!aiCoverText || !aiCoverText.value.trim()) return;
      try {
        await navigator.clipboard.writeText(aiCoverText.value);
        toast("Cover letter copied");
      } catch (_) {
        aiCoverText.select();
        document.execCommand("copy");
        toast("Cover letter copied");
      }
    });
  }

  const AI_SYSTEM_PROMPT =
    "You write short, professional cover letters. Output only the letter body, "
    + "max 220 words, 3 short paragraphs, no headings, no markdown, no preamble. "
    + "Never invent experience not in the CV. Be specific about why this role at "
    + "this company fits the candidate's background.";

  function buildCoverLetterPrompt(inputs) {
    const jd = (inputs.jd || "").slice(0, 3000);
    const cv = (inputs.cv || "").slice(0, 3000);
    return [
      `Write a 3-paragraph cover letter (max 220 words).`,
      `Company: ${inputs.company || "(unspecified)"}`,
      `Role: ${inputs.role || "(unspecified)"}`,
      ``,
      `JOB DESCRIPTION:`,
      jd || "(none provided)",
      ``,
      `CANDIDATE CV:`,
      cv || "(none provided)",
      ``,
      `Letter:`
    ].join("\n");
  }

  async function generateCoverLetterForCurrentJob() {
    if (!window.JobTrailAI) {
      toast("AI module not loaded", { error: true });
      return;
    }
    const inputs = collectCoverLetterInputs();
    const p = ensureProfileLoaded();
    const ai = p.ai || { provider: "none" };

    if (ai.provider === "none" || !ai.apiKey) {
      toast("Set an AI provider + API key in Profile first.", { error: true });
      openProfileModal();
      return;
    }
    if (!inputs.cv) {
      toast("Add a CV to your active section in Profile first.", { error: true });
      openProfileModal();
      return;
    }
    if (!inputs.role && !inputs.company) {
      toast("Add a job title and company before generating.", { error: true });
      return;
    }

    const job = currentJobFromForm();
    const inputsHash = data.hashCoverLetterInputs({
      cv: inputs.cv, jd: inputs.jd, role: inputs.role, company: inputs.company
    });

    // Cache hit: skip the network call entirely.
    if (job && job.aiCoverLetter && job.aiCoverLetter.inputsHash === inputsHash && job.aiCoverLetter.text) {
      aiCoverText.value = job.aiCoverLetter.text;
      setAiStatus(`Cached · ${job.aiCoverLetter.model || job.aiCoverLetter.provider}`);
      toast("Loaded cached letter");
      return;
    }

    aiCoverGenBtn.disabled = true;
    const originalLabel = aiCoverGenBtn.textContent;
    aiCoverGenBtn.textContent = "Generating…";
    setAiStatus(`Calling ${ai.provider}…`);
    aiCoverText.value = "";

    const prompt = buildCoverLetterPrompt(inputs);
    try {
      const finalText = await window.JobTrailAI.generate({
        provider: ai.provider,
        apiKey: ai.apiKey,
        model: ai.model,
        system: AI_SYSTEM_PROMPT,
        user: prompt,
        onChunk: (partial) => {
          // Stream tokens straight into the textarea. Keep the caret / scroll
          // pinned to the bottom so long letters stay visible as they write
          // themselves — matches the feel of chat UIs.
          aiCoverText.value = partial;
          aiCoverText.scrollTop = aiCoverText.scrollHeight;
        }
      });
      const trimmed = (finalText || aiCoverText.value || "").trim();
      aiCoverText.value = trimmed;
      setAiStatus(`Generated · ${ai.model || ai.provider}`);

      // Persist onto the job record so it syncs via Drive and re-opens instantly.
      if (trimmed && job) {
        const updated = Object.assign({}, job, {
          aiCoverLetter: {
            text: trimmed,
            model: ai.model || "",
            provider: ai.provider,
            inputsHash,
            generatedAt: new Date().toISOString()
          }
        });
        const sanitized = data.sanitizeJob(updated);
        state.jobs = state.jobs.map((j) => (j.id === sanitized.id ? sanitized : j));
        await saveToDrive();
        renderJobs();
      }
    } catch (err) {
      console.error(err);
      setAiStatus("");
      toast("AI generation failed: " + (err && err.message ? err.message : "unknown"), { error: true });
    } finally {
      aiCoverGenBtn.disabled = false;
      aiCoverGenBtn.textContent = originalLabel;
    }
  }

  if (aiCoverGenBtn) aiCoverGenBtn.addEventListener("click", generateCoverLetterForCurrentJob);

  // ---------- AI: fit analysis (CV ↔ JD) ----------
  //
  // Single shot, JSON response. We cache on the job so the score persists
  // across opens and syncs through Drive — invalidated when CV or JD changes.

  const aiFitBody = $("ai-fit-body");
  const aiFitToggle = $("ai-fit-toggle");
  const aiFitGenBtn = $("ai-fit-generate");
  const aiFitStatusEl = $("ai-fit-status");
  const aiFitResult = $("ai-fit-result");
  const aiFitScoreNum = $("ai-fit-score-num");
  const aiFitScoreRing = $("ai-fit-score-ring");
  const aiFitSummary = $("ai-fit-summary");
  const aiFitStrengths = $("ai-fit-strengths");
  const aiFitMissing = $("ai-fit-missing");

  function setFitStatus(label) {
    if (aiFitStatusEl) aiFitStatusEl.textContent = label || "";
  }

  function fitScoreColor(score) {
    if (score >= 75) return "#0f766e"; // teal — strong fit
    if (score >= 50) return "#d97706"; // amber — partial
    return "#b91c1c";                  // red — weak
  }

  function renderFitAnalysis(fit) {
    if (!aiFitResult) return;
    if (!fit) {
      aiFitResult.hidden = true;
      return;
    }
    aiFitResult.hidden = false;
    aiFitScoreNum.textContent = String(fit.score);
    aiFitScoreRing.style.setProperty("--fit-color", fitScoreColor(fit.score));
    aiFitScoreRing.style.setProperty("--fit-pct", String(fit.score));
    aiFitSummary.textContent = fit.summary || "";
    const renderList = (ul, items, emptyMsg) => {
      ul.innerHTML = "";
      const arr = Array.isArray(items) ? items : [];
      if (!arr.length) {
        const li = document.createElement("li");
        li.className = "fit-list-empty";
        li.textContent = emptyMsg;
        ul.appendChild(li);
        return;
      }
      arr.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      });
    };
    renderList(aiFitStrengths, fit.strengths, "No specific strengths called out.");
    renderList(aiFitMissing, fit.missing, "Nothing major missing — strong overlap.");
  }

  function loadCachedFitIntoModal(job) {
    setFitStatus("");
    renderFitAnalysis(null);
    if (!job || !job.aiFitAnalysis) return;
    const inputs = collectCoverLetterInputs();
    const freshHash = data.hashFitInputs({ cv: inputs.cv, jd: inputs.jd });
    renderFitAnalysis(job.aiFitAnalysis);
    if (job.aiFitAnalysis.inputsHash === freshHash) {
      setFitStatus(`Cached · ${job.aiFitAnalysis.model || job.aiFitAnalysis.provider || "AI"}`);
    } else {
      setFitStatus("Cached · CV or JD changed — re-run");
    }
  }

  if (aiFitToggle) {
    aiFitToggle.addEventListener("click", () => {
      if (!aiFitBody) return;
      const willShow = aiFitBody.hidden;
      aiFitBody.hidden = !willShow;
      aiFitToggle.textContent = willShow ? "Hide" : "Show";
      if (willShow) {
        const job = currentJobFromForm();
        if (job) loadCachedFitIntoModal(job);
      }
    });
  }

  const FIT_SYSTEM_PROMPT =
    "You are a hiring manager assessing CV-to-job fit. "
    + "Score 0–100 based on overlap of skills, seniority, and domain. "
    + "Be honest — most candidates score 40–70. Reserve 80+ for strong matches. "
    + "Return ONLY valid JSON, no markdown, no preamble. Schema: "
    + '{"score": integer 0-100, "strengths": [up to 5 short phrases], '
    + '"missing": [up to 5 short JD keywords absent from the CV], '
    + '"summary": "one sentence, max 220 chars"}.';

  function buildFitPrompt(inputs) {
    const cv = (inputs.cv || "").slice(0, 4000);
    const jd = (inputs.jd || "").slice(0, 4000);
    return [
      "CV:",
      cv,
      "",
      "Job description:",
      jd,
      "",
      "Return JSON only."
    ].join("\n");
  }

  // Some providers (Anthropic, on-device) ignore the responseFormat hint and
  // wrap JSON in prose. Extract the first balanced {…} block defensively.
  function extractJson(text) {
    const s = String(text || "");
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
  }

  async function analyzeFitForCurrentJob() {
    if (!window.JobTrailAI) {
      toast("AI module not loaded", { error: true });
      return;
    }
    const inputs = collectCoverLetterInputs();
    const p = ensureProfileLoaded();
    const ai = p.ai || { provider: "none" };

    if (ai.provider === "none" || !ai.apiKey) {
      toast("Set an AI provider + API key in Profile first.", { error: true });
      openProfileModal();
      return;
    }
    if (!inputs.cv) {
      toast("Add a CV to your active section in Profile first.", { error: true });
      openProfileModal();
      return;
    }
    if (!inputs.jd) {
      toast("This job has no description archived — paste one to analyze fit.", { error: true });
      return;
    }

    const job = currentJobFromForm();
    const inputsHash = data.hashFitInputs({ cv: inputs.cv, jd: inputs.jd });

    if (job && job.aiFitAnalysis && job.aiFitAnalysis.inputsHash === inputsHash) {
      renderFitAnalysis(job.aiFitAnalysis);
      setFitStatus(`Cached · ${job.aiFitAnalysis.model || job.aiFitAnalysis.provider}`);
      toast("Loaded cached analysis");
      return;
    }

    aiFitGenBtn.disabled = true;
    const originalLabel = aiFitGenBtn.textContent;
    aiFitGenBtn.textContent = "Analyzing…";
    setFitStatus(`Calling ${ai.provider}…`);

    try {
      const raw = await window.JobTrailAI.generate({
        provider: ai.provider,
        apiKey: ai.apiKey,
        model: ai.model,
        system: FIT_SYSTEM_PROMPT,
        user: buildFitPrompt(inputs),
        responseFormat: "json"
      });
      const parsed = extractJson(raw);
      if (!parsed || typeof parsed.score !== "number") {
        throw new Error("Model returned malformed JSON");
      }
      const fit = data.sanitizeAiFitAnalysis({
        score: parsed.score,
        strengths: parsed.strengths,
        missing: parsed.missing,
        summary: parsed.summary,
        model: ai.model || "",
        provider: ai.provider,
        inputsHash,
        generatedAt: new Date().toISOString()
      });
      if (!fit) throw new Error("Sanitized fit is empty");
      renderFitAnalysis(fit);
      setFitStatus(`Generated · ${ai.model || ai.provider}`);

      if (job) {
        const updated = Object.assign({}, job, { aiFitAnalysis: fit });
        const sanitized = data.sanitizeJob(updated);
        state.jobs = state.jobs.map((j) => (j.id === sanitized.id ? sanitized : j));
        await saveToDrive();
        renderJobs();
      }
    } catch (err) {
      console.error(err);
      setFitStatus("");
      toast("Fit analysis failed: " + (err && err.message ? err.message : "unknown"), { error: true });
    } finally {
      aiFitGenBtn.disabled = false;
      aiFitGenBtn.textContent = originalLabel;
    }
  }

  if (aiFitGenBtn) aiFitGenBtn.addEventListener("click", analyzeFitForCurrentJob);

  // ---------- PWA: service worker + install prompt ----------

  // Register the service worker so the shell works offline and the page is
  // installable. Only on secure contexts (https / localhost) — file:// loads
  // don't support SWs. Failures are silent; the app still works without one.
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js")
        .then((registration) => registration.update().catch(() => undefined))
        .catch((err) => {
          console.warn("Service worker registration failed:", err);
        });
    });
  }

  // `beforeinstallprompt` fires on Chrome/Edge when the app passes install
  // criteria. We stash the event and surface our own button — the browser's
  // native prompt only fires once per user gesture, so we drive it ourselves.
  let deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      installBtn.disabled = true;
      try {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === "accepted") {
          toast("Installing JobTrail…");
        }
      } catch (_) { /* user dismissed */ }
      deferredInstallPrompt = null;
      installBtn.hidden = true;
      installBtn.disabled = false;
    });
  }

  window.addEventListener("appinstalled", () => {
    if (installBtn) installBtn.hidden = true;
    deferredInstallPrompt = null;
    toast("Installed — launch JobTrail from your home screen");
  });
})();
