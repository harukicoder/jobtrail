// JobTrail webapp service worker.
//
// Role: make the shell installable + usable offline. The real data lives in
// Google Drive via authenticated calls — we intentionally never cache those
// requests. We cache the app shell (HTML/CSS/JS/icons) with a network-first
// strategy so users always get the latest deploy when online and still see a
// working UI offline.

// Bump this whenever the shell changes so browsers drop the old cache.
const CACHE_NAME = "jobtrail-shell-v19";
const SHELL_URLS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./ai.js",
  "./data.js",
  "./drive-sync.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-maskable.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll is atomic: if any fetch fails, install fails. Use individual
      // puts so a missing optional file (e.g. config.js) doesn't break boot.
      Promise.all(
        SHELL_URLS.map((url) =>
          fetch(url, { cache: "no-cache" })
            .then((res) => (res.ok ? cache.put(url, res.clone()) : null))
            .catch(() => null)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only handle same-origin shell requests. Google APIs (oauth2, drive) must
  // always hit the network with fresh auth headers — never intercept them.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Only cache successful, basic responses. Skip opaque / partial.
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match("./index.html"))
      )
  );
});
