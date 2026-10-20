// Service Worker für den Essensplan.
// Strategie: Wenn das Netz da ist, wird immer die neueste Version geladen.
// Ohne Netz startet die App aus dem Zwischenspeicher (offline).
// Bei Änderungen an der Dateiliste unten die Versionsnummer erhöhen.
const VERSION = "essensplan-v13";
const DATEIEN = [
  "./",
  "index.html",
  "style.css",
  "config.js",
  "supabase.js",
  "app.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png"
];

self.addEventListener("install", function (ereignis) {
  ereignis.waitUntil(
    caches.open(VERSION).then(function (cache) {
      return cache.addAll(DATEIEN.map(function (d) { return new Request(d, { cache: "reload" }); }));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (ereignis) {
  ereignis.waitUntil(
    caches.keys().then(function (namen) {
      return Promise.all(
        namen.filter(function (n) { return n !== VERSION; })
             .map(function (n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (ereignis) {
  const anfrage = ereignis.request;
  if (anfrage.method !== "GET" || new URL(anfrage.url).origin !== self.location.origin) return;

  ereignis.respondWith(
    fetch(anfrage, { cache: "no-cache" })
      .then(function (antwort) {
        if (antwort.ok) {
          const kopie = antwort.clone();
          caches.open(VERSION).then(function (cache) { cache.put(anfrage, kopie); });
        }
        return antwort;
      })
      .catch(function () {
        return caches.match(anfrage, { ignoreSearch: true }).then(function (treffer) {
          return treffer || caches.match("index.html");
        });
      })
  );
});
