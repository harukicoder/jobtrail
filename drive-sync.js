(function initJobTrailDrive(globalScope) {
  // Drive-backed storage for JobTrail. Token-agnostic — pass in a provider
  // that returns a fresh OAuth access token each call.
  // Works from the extension (chrome.identity.launchWebAuthFlow) and from the
  // webapp (Google Identity Services initTokenClient). No Google client code
  // is bundled here; callers do the auth handshake and hand us the token.
  //
  // Layout: a single JSON file at Drive:/JobTrail/jobtrail-data.json.

  const APP_FOLDER = "JobTrail";
  const DATA_FILE = "jobtrail-data.json";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const JSON_MIME = "application/json";
  const SCHEMA_VERSION = 1;
  const APP_PROPERTY_KEY = "jobtrailDataFile";
  const APP_PROPERTY_VALUE = "primary";

  let tokenGetter = async () => null;
  let folderIdCache = null;
  let dataFileIdCache = null;

  function setTokenProvider(fn) {
    tokenGetter = typeof fn === "function" ? fn : async () => null;
    // New provider → old file ids are no longer trusted.
    folderIdCache = null;
    dataFileIdCache = null;
  }

  async function authHeader() {
    const token = await tokenGetter();
    if (!token) throw new Error("Not signed in to Google.");
    return { Authorization: `Bearer ${token}` };
  }

  async function driveFetch(url, init) {
    const headers = Object.assign({}, (init && init.headers) || {}, await authHeader());
    const resp = await fetch(url, Object.assign({}, init || {}, { headers }));
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Drive ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp;
  }

  async function findFolderId() {
    if (folderIdCache) return folderIdCache;
    const q = encodeURIComponent(
      `name='${APP_FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`
    );
    const resp = await driveFetch(
      `${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=5`
    );
    const json = await resp.json();
    if (json.files && json.files.length > 0) {
      folderIdCache = json.files[0].id;
      return folderIdCache;
    }
    const createResp = await driveFetch(`${DRIVE_API}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: APP_FOLDER, mimeType: FOLDER_MIME })
    });
    const created = await createResp.json();
    folderIdCache = created.id;
    return folderIdCache;
  }

  async function listFilesByQuery(query, fields, pageSize) {
    const q = encodeURIComponent(query);
    const reqFields = fields || "files(id,name,modifiedTime)";
    const size = Number(pageSize) || 10;
    const resp = await driveFetch(
      `${DRIVE_API}/files?q=${q}&spaces=drive&fields=${encodeURIComponent(reqFields)}&orderBy=modifiedTime desc&pageSize=${size}`
    );
    const json = await resp.json();
    return Array.isArray(json.files) ? json.files : [];
  }

  async function findTaggedDataFileId() {
    const files = await listFilesByQuery(
      `appProperties has { key='${APP_PROPERTY_KEY}' and value='${APP_PROPERTY_VALUE}' } and trashed=false`,
      "files(id,name,modifiedTime)",
      5
    );
    return files[0] ? files[0].id : null;
  }

  async function findLatestLegacyDataFileId() {
    const files = await listFilesByQuery(
      `name='${DATA_FILE}' and trashed=false`,
      "files(id,name,modifiedTime,parents)",
      20
    );
    return files[0] ? files[0].id : null;
  }

  async function findDataFileId() {
    if (dataFileIdCache) return dataFileIdCache;
    const taggedId = await findTaggedDataFileId().catch(() => null);
    if (taggedId) {
      dataFileIdCache = taggedId;
      return dataFileIdCache;
    }
    const legacyId = await findLatestLegacyDataFileId().catch(() => null);
    if (legacyId) {
      dataFileIdCache = legacyId;
      return dataFileIdCache;
    }
    return null;
  }

  async function ensureFileTagged(fileId) {
    if (!fileId) return;
    try {
      await driveFetch(`${DRIVE_API}/files/${fileId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appProperties: {
            [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE
          }
        })
      });
    } catch (_) {
      // Best-effort only. Reads can still fall back to filename search.
    }
  }

  function emptyDataset() {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      jobs: [],
      profile: null,
      autofillMappings: {}
    };
  }

  function normalizeDataset(raw) {
    const base = emptyDataset();
    if (!raw || typeof raw !== "object") return base;
    return {
      schemaVersion: Number(raw.schemaVersion) || SCHEMA_VERSION,
      updatedAt: String(raw.updatedAt || base.updatedAt),
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      profile: raw.profile && typeof raw.profile === "object" ? raw.profile : null,
      autofillMappings:
        raw.autofillMappings && typeof raw.autofillMappings === "object"
          ? raw.autofillMappings
          : {}
    };
  }

  async function readData() {
    const fileId = await findDataFileId();
    if (!fileId) return emptyDataset();
    const resp = await driveFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
    const text = await resp.text();
    try {
      return normalizeDataset(JSON.parse(text));
    } catch (_) {
      return emptyDataset();
    }
  }

  function buildMultipartBody(metadata, contentString, boundary) {
    // Minimal multipart/related body for Drive multipart upload.
    const lines = [];
    lines.push(`--${boundary}`);
    lines.push("Content-Type: application/json; charset=UTF-8");
    lines.push("");
    lines.push(JSON.stringify(metadata));
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${JSON_MIME}`);
    lines.push("");
    lines.push(contentString);
    lines.push(`--${boundary}--`);
    return lines.join("\r\n");
  }

  async function writeData(dataset) {
    const payload = normalizeDataset(dataset);
    payload.updatedAt = new Date().toISOString();
    const contentString = JSON.stringify(payload);
    const existingId = await findDataFileId();

    if (existingId) {
      await ensureFileTagged(existingId);
      await driveFetch(
        `${UPLOAD_API}/files/${existingId}?uploadType=media`,
        {
          method: "PATCH",
          headers: { "Content-Type": JSON_MIME },
          body: contentString
        }
      );
      return payload;
    }

    const folderId = await findFolderId();
    const boundary = `jobtrail_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const body = buildMultipartBody(
      {
        name: DATA_FILE,
        parents: [folderId],
        mimeType: JSON_MIME,
        appProperties: {
          [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE
        }
      },
      contentString,
      boundary
    );
    const resp = await driveFetch(
      `${UPLOAD_API}/files?uploadType=multipart&fields=id`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body
      }
    );
    const created = await resp.json();
    dataFileIdCache = created.id;
    return payload;
  }

  async function checkSignedIn() {
    try {
      const token = await tokenGetter();
      return Boolean(token);
    } catch (_) {
      return false;
    }
  }

  function invalidateFileCache() {
    // Call after sign-out or account switch.
    folderIdCache = null;
    dataFileIdCache = null;
  }

  globalScope.JobTrailDrive = {
    APP_FOLDER,
    DATA_FILE,
    SCHEMA_VERSION,
    setTokenProvider,
    readData,
    writeData,
    checkSignedIn,
    invalidateFileCache,
    emptyDataset,
    normalizeDataset
  };
})(typeof self !== "undefined" ? self : window);
