(function initJobTrailWebapp() {
  "use strict";

  const data = window.JobCRMData;
  const drive = window.JobTrailDrive;
  const driveAuth = window.JobTrailDriveAuth || null;
  const config = window.JOBTRAIL_CONFIG || {};
  const runtime = window.JOBTRAIL_RUNTIME || {};
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const isExtensionRuntime = Boolean(runtime.isExtension && driveAuth);

  // In-memory dataset; Drive is the source of truth on disk.
  let state = {
    jobs: [],
    profile: null,
    autofillMappings: {},
    loaded: false
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
  const TOKEN_CACHE_KEY = "jobtrail_oauth_token_v1";

  function readCachedToken() {
    try {
      const raw = localStorage.getItem(TOKEN_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.token !== "string" || !parsed.token) return null;
      if (typeof parsed.expiry !== "number" || Date.now() >= parsed.expiry) return null;
      return parsed;
    } catch (_) { return null; }
  }
  function writeCachedToken(token, expiry) {
    try { localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ token, expiry })); } catch (_) {}
  }
  function clearCachedToken() {
    try { localStorage.removeItem(TOKEN_CACHE_KEY); } catch (_) {}
  }

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const signInBtn = $("signin-button");
  const signOutBtn = $("signout-button");
  const syncPill = $("sync-pill");
  const exportBtn = $("export-button");
  const importBtn = $("import-button");
  const importInput = $("import-input");
  const installBtn = $("install-button");
  const profileBtn = $("profile-button");
  const signedOutCard = $("signed-out-card");
  const statsRow = $("stats-row");
  const viewTabs = $("view-tabs");
  const funnelSection = $("funnel-section");
  const jobsSection = $("jobs-section");
  const jobsEmpty = $("jobs-empty");
  const jobsTbody = $("jobs-tbody");
  const jobsSearch = $("jobs-search");
  const jobsFilterStatus = $("jobs-filter-status");
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

  async function loadFromDrive() {
    setSync("syncing", "Loading…");
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
      setSync("signed-in", "Synced");
      return;
    }
    const dataset = await drive.readData();
    // Keep tombstones in state (we'll push them back to Drive on save, so they
    // continue to propagate) — but they're filtered out of every UI read.
    applyDatasetToState(dataset);
    await mirrorStateToExtensionStorage();
    setSync("signed-in", "Synced");
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
    setSync("syncing", "Saving…");
    saveInFlight = true;
    try {
      if (isExtensionRuntime) {
        await mirrorStateToExtensionStorage();
        const signedIn = await driveAuth.isSignedIn();
        if (!signedIn) {
          lastSaveFailedAt = 0;
          setSync("", "Local only");
          return;
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
    } catch (err) {
      console.error("saveToDrive failed:", err);
      lastSaveFailedAt = Date.now();
      setSync("signed-in", "Save failed — retry");
      // Big visible toast — easy to miss the small sync pill text alone.
      toast("Save failed: " + (err && err.message ? err.message : "network error") + " — your changes are still in this tab; click Save again.", { error: true });
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
    return `<span class="status-chip" style="background:${color}">${escapeHtml(label)}</span>`;
  }

  // Sortable columns: persisted to localStorage so the user's choice survives
  // refreshes. `dateApplied` desc is the sensible default — most-recent first.
  const SORT_PREF_KEY = "jobtrail_sort_pref_v1";
  const SORT_ORDER = ["bookmarked", "applying", "applied", "interviewing", "offer", "rejected", "archived"];
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

  function compareJobs(a, b, key, dir) {
    const mul = dir === "asc" ? 1 : -1;
    if (key === "status") {
      const ai = SORT_ORDER.indexOf(a.status); const bi = SORT_ORDER.indexOf(b.status);
      return mul * (ai - bi);
    }
    if (key === "dateApplied") {
      // Empty dates sort last regardless of direction so blank rows don't leap
      // to the top of an ascending sort.
      const av = a.dateApplied || ""; const bv = b.dateApplied || "";
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return mul * (av < bv ? -1 : av > bv ? 1 : 0);
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
      if (status && j.status !== status) return false;
      if (!q) return true;
      const hay = [j.jobTitle, j.company, j.location, j.notes].join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    return list.sort((a, b) => compareJobs(a, b, sortState.key, sortState.dir));
  }

  function renderJobs() {
    const jobs = filteredJobs();
    jobsEmpty.hidden = jobs.length !== 0;
    jobsTbody.innerHTML = jobs.map((j) => {
      const urlLink = j.url
        ? `<a href="${escapeHtml(j.url)}" target="_blank" rel="noopener noreferrer" data-stop-row>Open</a>`
        : "";
      const hasPrep = data.hasInterviewPrepContent && data.hasInterviewPrepContent(j.interviewPrep);
      const prepBadge = hasPrep ? '<span class="jd-badge" title="Interview prep saved">🎤</span>' : "";
      const letterBadge = (j.aiCoverLetter && j.aiCoverLetter.text)
        ? '<span class="jd-badge" title="AI cover letter cached">✉️</span>' : "";
      const fitBadge = (j.aiFitAnalysis && typeof j.aiFitAnalysis.score === "number")
        ? `<span class="fit-pill" style="--fit-color:${fitScoreColor(j.aiFitAnalysis.score)}" title="CV ↔ JD fit score">${j.aiFitAnalysis.score}</span>`
        : "";
      return `
        <tr class="job-row" data-action="edit" data-id="${escapeHtml(j.id)}" tabindex="0" role="button" aria-label="Edit ${escapeHtml(j.jobTitle || "job")}">
          <td class="job-title-cell">
            <strong>${escapeHtml(j.jobTitle || "(untitled)")}</strong>
            ${j.description ? '<span class="jd-badge" title="Job description archived">📄</span>' : ""}
            ${prepBadge}
            ${letterBadge}
            ${fitBadge}
            ${urlLink}
          </td>
          <td>${escapeHtml(j.company || "")}</td>
          <td>${escapeHtml(j.location || "")}</td>
          <td>${j.workMode ? escapeHtml(j.workMode) : '<span class="cell-muted">—</span>'}</td>
          <td>${statusChip(j.status)}</td>
          <td>${escapeHtml(j.dateApplied || "")}</td>
          <td>
            <div class="row-actions">
              <button class="primary-button" data-action="edit" data-id="${escapeHtml(j.id)}">Edit</button>
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
    currentView = view === "funnel" ? "funnel" : "pipeline";
    document.querySelectorAll(".view-tab").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.view === currentView);
    });
    if (currentView === "funnel") {
      jobsSection.hidden = true;
      funnelSection.hidden = false;
      renderFunnel();
    } else {
      funnelSection.hidden = true;
      jobsSection.hidden = false;
    }
  }

  if (viewTabs) {
    viewTabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".view-tab");
      if (!btn) return;
      setView(btn.dataset.view);
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
      }
    };

    const existing = payload.id && state.jobs.find((j) => j.id === payload.id);
    const merged = Object.assign({}, existing || {}, payload, {
      createdAt: (existing && existing.createdAt) || undefined
    });
    // Append a stage-history entry whenever the status actually changes so
    // the timeline grows through normal webapp edits, not just extension saves.
    merged.stageHistory = data.appendStageTransition(
      (existing && existing.stageHistory) || merged.stageHistory || [],
      merged.status,
      new Date().toISOString()
    );
    const sanitized = data.sanitizeJob(merged);

    if (existing) {
      state.jobs = state.jobs.map((j) => (j.id === sanitized.id ? sanitized : j));
    } else {
      state.jobs.unshift(sanitized);
    }

    closeModal();
    renderJobs();
    await saveToDrive();
    // Notify the extension content script (if present) that we just updated Drive.
    window.postMessage({ type: "JOBTRAIL_SYNC_REQUEST" }, "*");
    toast("Saved");
  });

  jobDeleteBtn.addEventListener("click", async () => {
    const id = $("field-id").value;
    if (!id) return;
    if (!confirm("Delete this job? This can't be undone.")) return;
    // Soft delete: mark tombstone so the deletion propagates to the extension
    // via Drive sync. Tombstones are purged after 30 days.
    const now = new Date().toISOString();
    state.jobs = state.jobs.map((j) =>
      j.id === id ? Object.assign({}, j, { deletedAt: now, updatedAt: now }) : j
    );
    closeModal();
    renderJobs();
    await saveToDrive();
    // Notify the extension content script (if present) that we just updated Drive.
    window.postMessage({ type: "JOBTRAIL_SYNC_REQUEST" }, "*");
    toast("Deleted");
  });

  function openJobForEdit(id) {
    const job = state.jobs.find((j) => j.id === id);
    if (job) openModal(job);
  }

  jobsTbody.addEventListener("click", (e) => {
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
      await saveToDrive();
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
  function pullSuppressed() {
    if (saveInFlight) return true;
    if (lastSaveFailedAt && Date.now() - lastSaveFailedAt < FAILED_SAVE_GUARD_MS) return true;
    return false;
  }

  async function pullFromDriveIfDue() {
    if (!state.loaded) return;
    if (pullSuppressed()) return;
    if (isExtensionRuntime) {
      const signedIn = await driveAuth.isSignedIn();
      if (!signedIn) return;
    }
    if (Date.now() - lastVisiblePullAt < VISIBLE_PULL_COOLDOWN_MS) return;
    lastVisiblePullAt = Date.now();
    try {
      await loadFromDrive();
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
      if (pullSuppressed()) return;
      if (isExtensionRuntime) {
        const signedIn = await driveAuth.isSignedIn();
        if (!signedIn) return;
      }
      try {
        await loadFromDrive();
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
    exportBtn.disabled = false;
    importBtn.disabled = false;
    setView(currentView);
  }

  function showExtensionLocalMode() {
    signedOutCard.hidden = true;
    statsRow.hidden = false;
    if (viewTabs) viewTabs.hidden = false;
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
    if (profileBtn) profileBtn.hidden = false;
    exportBtn.disabled = false;
    importBtn.disabled = false;
    setView(currentView);
  }

  function showSignedOut() {
    signedOutCard.hidden = false;
    statsRow.hidden = true;
    if (viewTabs) viewTabs.hidden = true;
    funnelSection.hidden = true;
    jobsSection.hidden = true;
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
    if (profileBtn) profileBtn.hidden = true;
    exportBtn.disabled = true;
    importBtn.disabled = true;
    setSync("", "Not signed in");
  }

  signInBtn.addEventListener("click", signIn);
  signOutBtn.addEventListener("click", signOut);

  // ---------- Boot ----------

  drive.setTokenProvider(isExtensionRuntime && driveAuth ? driveAuth.tokenProvider : tokenProvider);
  populateStatusSelects();
  showSignedOut();

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
    "city", "country", "linkedinUrl", "githubUrl", "portfolioUrl"
  ];
  const SECTION_PROFILE_INPUTS = [
    "yearsExperience", "desiredSalary", "workAuthorization",
    "noticePeriod", "preferredStartDate", "resumeText", "coverLetter"
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

  function writeSectionFieldsFromState() {
    const p = ensureProfileLoaded();
    const section = p.sections.find((s) => s.id === editingSectionId) || p.sections[0];
    SECTION_PROFILE_INPUTS.forEach((key) => {
      $("profile-" + key).value = section[key] || "";
    });
    renderSavedAnswers();
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
      const anyDefault = Object.values(data.AI_DEFAULT_MODEL).includes(current);
      if (!current || anyDefault) $("profile-ai-model").value = defaultModel;
    });
  }

  if (profileForm) {
    profileForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      readProfileFormIntoState();
      state.profile = data.sanitizeProfile(state.profile);
      closeProfileModal();
      await saveToDrive();
      // Notify the extension content script (if present) that we just updated Drive.
      window.postMessage({ type: "JOBTRAIL_SYNC_REQUEST" }, "*");
      toast("Profile saved");
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
      navigator.serviceWorker.register("sw.js").catch((err) => {
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
