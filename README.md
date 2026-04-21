# JobTrail webapp

A static, single-user CRM that stores your data in **your own Google Drive**. Host it on GitHub Pages (or any static host) and it becomes the "Open CRM" target for the JobTrail Chrome extension.

- **Storage:** one JSON file at `Drive:/JobTrail/jobtrail-data.json`, owned by this app via the `drive.file` OAuth scope. This app can only see files it creates — it cannot read anything else in your Drive.
- **Auth:** Google Identity Services (in-browser OAuth). No backend, no Firebase, no server-side keys.
- **Hosting:** static files only. Works on GitHub Pages, Netlify, Vercel, etc.

## 1. Create a Google OAuth Client ID

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
2. **APIs & Services → Library** → search for **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - Fill in required fields (app name, support email, developer contact).
   - Scopes: add `https://www.googleapis.com/auth/drive.file`.
   - Test users: add your own Google account (while the app is in "Testing" mode).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins: add the URL where you'll host the webapp, e.g.
     - `https://<your-github-username>.github.io`
     - `http://localhost:8000` (optional, for local dev)
   - Save and copy the generated **Client ID** (looks like `1234-abc.apps.googleusercontent.com`).

> You do **not** need a client secret. Web OAuth with GIS only needs the Client ID.

## 2. Configure the webapp

```bash
cp webapp/config.example.js webapp/config.js
```

Edit `webapp/config.js` and paste your Client ID:

```js
window.JOBTRAIL_CONFIG = {
  googleClientId: "1234-abc.apps.googleusercontent.com"
};
```

## 3. Deploy to GitHub Pages

The `webapp/` folder is self-contained — `data.js` and `drive-sync.js` now live inside it, so you can push just this folder as the root of a GitHub repo.

Option A — dedicated repo (recommended, what the "Open CRM" button expects):

1. Create a new GitHub repo (e.g. `jobtrail`).
2. Copy everything inside `webapp/` to the repo root (so `index.html`, `app.js`, `data.js`, `drive-sync.js`, `config.js`, etc. sit at the top level).
3. Push, then enable **Settings → Pages** → Source: `main` / `/ (root)`.
4. Visit `https://<your-username>.github.io/<repo>/`.

Option B — keep the full extension repo and serve the subfolder:

1. Push the whole `Codex_CRM` repo.
2. **Settings → Pages** → Source: `main` / `/ (root)`.
3. Visit `https://<your-username>.github.io/<repo>/webapp/`.

Make sure the URL you visit matches the **Authorized JavaScript origin** you set in step 1.

## 4. Local development

All scripts the webapp needs sit next to `index.html`, so you can serve the folder directly:

```bash
cd /path/to/Codex_CRM/webapp
python3 -m http.server 8000
# open http://localhost:8000/
```

Add `http://localhost:8000` to the authorized origins in the Cloud Console, or create a separate "localhost" OAuth client.

## 5. Wire up the extension (optional)

The extension's "Open CRM" button opens the webapp when `window.JOBTRAIL_WEBAPP_URL` is set in `popup.js`. See the extension's root `README.md` for details. If the webapp URL is not configured, the button falls back to the bundled `dashboard.html`.

## What gets stored

`jobtrail-data.json` in Drive looks like:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-04-21T18:00:00.000Z",
  "jobs": [ /* same shape as the extension's records */ ],
  "profile": null,
  "autofillMappings": {}
}
```

The webapp writes this file on every save. If you want a backup, use **Export JSON** in the header — that downloads a local copy.

## Privacy

- The `drive.file` scope means Google only exposes files this app has created to it. You can revoke access anytime at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- No telemetry. No server. The Client ID is public-by-design; it's pinned to your authorized origins so nobody else can hijack it from a different domain.
