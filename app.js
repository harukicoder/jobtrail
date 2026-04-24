(function initJobTrailWebapp() {
  "use strict";

  const data = window.JobCRMData;
  const drive = window.JobTrailDrive;
  const config = window.JOBTRAIL_CONFIG || {};
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

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

  // ---------- OAuth via Google Identity Services ----------

  function hasValidClientId() {
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
    if (currentToken && Date.now() < tokenExpiry) return currentToken;
    // Try silent refresh first. If user previously consented, this works.
    const silent = await requestToken({ interactive: false });
    if (silent) return silent;
    return null;
  }

  function clearToken() {
    if (currentToken && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(currentToken, () => {}); } catch (_) {}
    }
    currentToken = null;
    tokenExpiry = 0;
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

  async function loadFromDrive() {
    setSync("syncing", "Loading…");
    const dataset = await drive.readData();
    // Keep tombstones in state (we'll push them back to Drive on save, so they
    // continue to propagate) — but they're filtered out of every UI read.
    state.jobs = (dataset.jobs || []).map((j) => data.sanitizeJob(j));
    state.profile = dataset.profile || null;
    state.autofillMappings = dataset.autofillMappings || {};
    state.loaded = true;
    setSync("signed-in", "Synced");
  }

  async function saveToDrive() {
    setSync("syncing", "Saving…");
    try {
      await drive.writeData({
        jobs: state.jobs, // include tombstones so deletions propagate
        profile: state.profile,
        autofillMappings: state.autofillMappings
      });
      setSync("signed-in", "Synced");
    } catch (err) {
      console.error(err);
      setSync("signed-in", "Save failed");
      toast("Failed to save to Drive: " + err.message, { error: true });
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

  function filteredJobs() {
    const q = (jobsSearch.value || "").trim().toLowerCase();
    const status = jobsFilterStatus.value;
    return liveJobs().filter((j) => {
      if (status && j.status !== status) return false;
      if (!q) return true;
      const hay = [j.jobTitle, j.company, j.location, j.notes].join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });
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
      return `
        <tr class="job-row" data-action="edit" data-id="${escapeHtml(j.id)}" tabindex="0" role="button" aria-label="Edit ${escapeHtml(j.jobTitle || "job")}">
          <td class="job-title-cell">
            <strong>${escapeHtml(j.jobTitle || "(untitled)")}</strong>
            ${j.description ? '<span class="jd-badge" title="Job description archived">📄</span>' : ""}
            ${prepBadge}
            ${letterBadge}
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
    recomputeStats();
    renderFunnel();
  }

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
    const sanitized = data.sanitizeJob(
      Object.assign({}, existing || {}, payload, {
        createdAt: (existing && existing.createdAt) || undefined
      })
    );

    if (existing) {
      state.jobs = state.jobs.map((j) => (j.id === sanitized.id ? sanitized : j));
    } else {
      state.jobs.unshift(sanitized);
    }

    closeModal();
    renderJobs();
    await saveToDrive();
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

  function signOut() {
    try { localStorage.removeItem(SIGNED_IN_FLAG); } catch (_) {}
    clearToken();
    state = { jobs: [], profile: null, autofillMappings: {}, loaded: false };
    showSignedOut();
  }

  async function attemptSilentRestore() {
    // On page load, if the user has signed in before on this device, try to
    // get a fresh token silently. Google will honor it as long as the user
    // hasn't revoked access and the browser still holds the consent cookie.
    let flag;
    try { flag = localStorage.getItem(SIGNED_IN_FLAG); } catch (_) { flag = null; }
    if (!flag || !hasValidClientId()) return;

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

  drive.setTokenProvider(tokenProvider);
  populateStatusSelects();
  showSignedOut();

  if (!hasValidClientId()) {
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
