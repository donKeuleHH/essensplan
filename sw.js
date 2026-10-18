// Service Worker für den Essensplan.
// Speichert die App-Dateien auf dem Gerät, damit die App auch offline startet.
// Bei jeder Änderung an der App die Versionsnummer erhöhen (z. B. v2),
// damit die iPhones die neuen Dateien laden.
const VERSION = "essensplan-v1";
const DATEIEN = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png"
];

self.addEventListener("install", function (ereignis) {
  ereignis.waitUntil(
    caches.open(VERSION).then(function (cache) { return cache.addAll(DATEIEN); })
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

// Erst im Cache nachsehen, sonst aus dem Netz laden.
self.addEventListener("fetch", function (ereignis) {
  if (ereignis.request.method !== "GET") return;
  ereignis.respondWith(
    caches.match(ereignis.request).then(function (treffer) {
      return treffer || fetch(ereignis.request);
    })
  );
});
