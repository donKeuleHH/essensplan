// Service Worker für MealMap.
// Strategie: Wenn das Netz da ist, wird immer die neueste Version geladen.
// Ohne Netz startet die App aus dem Zwischenspeicher (offline).
// Bei Änderungen an der Dateiliste unten die Versionsnummer erhöhen.
const VERSION = "essensplan-v92";
const DATEIEN = [
  "./",
  "index.html",
  "style.css",
  "config.js",
  "supabase.js",
  "app.js",
  "manifest.webmanifest",
  "app-icon-192.png",
  "app-icon-512.png",
  "app-icon-180.png",
  "fonts/nunito-latin.woff2"
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

// Mitteilungen (Web-Push): Anzeige und Tipp darauf
self.addEventListener("push", function (ereignis) {
  let daten = {};
  try { daten = ereignis.data ? ereignis.data.json() : {}; }
  catch (f) { daten = { titel: "MealMap", text: ereignis.data ? ereignis.data.text() : "" }; }
  ereignis.waitUntil(self.registration.showNotification(daten.titel || "MealMap", {
    body: daten.text || "",
    icon: "app-icon-192.png",
    badge: "app-icon-192.png",
    tag: "einkauf",
    renotify: true,
    data: { url: daten.url || "./" }
  }));
});

self.addEventListener("notificationclick", function (ereignis) {
  ereignis.notification.close();
  const ziel = (ereignis.notification.data && ereignis.notification.data.url) || "./";
  ereignis.waitUntil((async function () {
    const fenster = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const f of fenster) {
      if ("focus" in f) { await f.focus(); f.postMessage({ art: "zu-einkauf" }); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(ziel);
  })());
});
