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
  const signedOutCard = $("signed-out-card");
  const statsRow = $("stats-row");
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
      return `
        <tr class="job-row" data-action="edit" data-id="${escapeHtml(j.id)}" tabindex="0" role="button" aria-label="Edit ${escapeHtml(j.jobTitle || "job")}">
          <td class="job-title-cell">
            <strong>${escapeHtml(j.jobTitle || "(untitled)")}</strong>
            ${urlLink}
          </td>
          <td>${escapeHtml(j.company || "")}</td>
          <td>${escapeHtml(j.location || "")}</td>
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
      notes: $("field-notes").value.trim()
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
    jobsSection.hidden = false;
    signInBtn.hidden = true;
    signOutBtn.hidden = false;
    exportBtn.disabled = false;
    importBtn.disabled = false;
  }

  function showSignedOut() {
    signedOutCard.hidden = false;
    statsRow.hidden = true;
    jobsSection.hidden = true;
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
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
})();
