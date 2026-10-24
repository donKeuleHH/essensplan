"use strict";

/* =====================================================================
   MealMap
   Alle Daten liegen zuerst auf dem Gerät (IndexedDB), die App funktioniert
   also auch offline. Ist in config.js ein Supabase-Projekt eingetragen und
   man angemeldet, werden die Daten zusätzlich mit den anderen Geräten abgeglichen.
   ===================================================================== */

const EINHEITEN = ["g", "kg", "ml", "l", "Stück", "EL", "TL", "Packung", "Dose", "Bund", "Prise"];

/* ---------- Datenbank ---------- */

let db = null;

function datenbankOeffnen() {
  return new Promise(function (resolve, reject) {
    const anfrage = indexedDB.open("essensplan", 5);
    anfrage.onupgradeneeded = function () {
      const d = anfrage.result;
      if (!d.objectStoreNames.contains("gerichte")) {
        d.createObjectStore("gerichte", { keyPath: "id", autoIncrement: true });
      }
      // Ab Version 2: Wochenpläne (ein Eintrag pro Woche, Schlüssel = Datum des Montags)
      if (!d.objectStoreNames.contains("wochenplan")) {
        d.createObjectStore("wochenplan", { keyPath: "woche" });
      }
      // Ab Version 3: abgehakte Posten der Einkaufsliste (ein Eintrag pro Woche)
      if (!d.objectStoreNames.contains("einkauf")) {
        d.createObjectStore("einkauf", { keyPath: "woche" });
      }
      // Ab Version 4: Haken pro Einkaufsposten (Schlüssel = "Woche|Posten"), damit
      // zwei Geräte gleichzeitig abhaken können. Der alte Speicher "einkauf" wird nur noch zum Übernehmen gelesen.
      if (!d.objectStoreNames.contains("haken")) {
        d.createObjectStore("haken", { keyPath: "id" });
      }
      // Ab Version 5: eigene Artikel auf der Einkaufsliste (ein Eintrag pro Artikel und Woche)
      if (!d.objectStoreNames.contains("extras")) {
        d.createObjectStore("extras", { keyPath: "id" });
      }
    };
    anfrage.onsuccess = function () { resolve(anfrage.result); };
    anfrage.onerror = function () { reject(anfrage.error); };
  });
}

function gerichteLaden() {
  return new Promise(function (resolve, reject) {
    const anfrage = db.transaction("gerichte", "readonly").objectStore("gerichte").getAll();
    anfrage.onsuccess = function () { resolve(anfrage.result); };
    anfrage.onerror = function () { reject(anfrage.error); };
  });
}

function alleLesen(speicherName) {
  return new Promise(function (resolve, reject) {
    const anfrage = db.transaction(speicherName, "readonly").objectStore(speicherName).getAll();
    anfrage.onsuccess = function () { resolve(anfrage.result); };
    anfrage.onerror = function () { reject(anfrage.error); };
  });
}

// Führt eine Schreibaktion aus und wartet, bis sie wirklich gespeichert ist.
function schreiben(speicherName, aktion) {
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(speicherName, "readwrite");
    const anfrage = aktion(tx.objectStore(speicherName));
    tx.oncomplete = function () { resolve(anfrage.result); };
    tx.onerror = function () { reject(tx.error); };
    tx.onabort = function () { reject(tx.error); };
  });
}

// Mehrere Speicher in einer gemeinsamen Transaktion schreiben (alles oder nichts).
function transaktion(namen, aktion) {
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(namen, "readwrite");
    const speicher = {};
    namen.forEach(function (n) { speicher[n] = tx.objectStore(n); });
    aktion(speicher);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
    tx.onabort = function () { reject(tx.error); };
  });
}

// Zufällige ID (UUID) für neue Gerichte, damit sich zwei Geräte nie in die Quere kommen.
function neueId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

// Kleine Merkzettel im Browser (z. B. bis wohin schon abgeglichen wurde).
// Gehen sie verloren, wird beim nächsten Mal einfach alles neu abgeglichen.
function merkenLesen(schluessel) {
  try { return localStorage.getItem("essensplan." + schluessel); } catch (f) { return null; }
}
function merkenSchreiben(schluessel, wert) {
  try { localStorage.setItem("essensplan." + schluessel, String(wert)); } catch (f) { /* nicht schlimm */ }
}

// Neuer Zeitstempel, der garantiert größer ist als der bisherige desselben Eintrags.
function zeitNach(alt) {
  return Math.max(Date.now(), alt && alt.aktualisiert ? alt.aktualisiert + 1 : 0);
}

// Einmalige Umstellung älterer Daten auf das Synchronisierungs-Format:
// Gerichte bekommen eine UUID statt einer Zahl (der Wochenplan wird mit umgestellt),
// die abgehakten Einkaufsposten werden zu einzelnen Haken. Danach ist alles "zu senden" markiert.
async function datenMigrieren() {
  const jetzt = Date.now();
  const alteGerichte = (await alleLesen("gerichte")).filter(function (g) { return typeof g.id === "number"; });
  const alteHaken = await alleLesen("einkauf");
  if (alteGerichte.length === 0 && alteHaken.length === 0) return;

  const neueIds = new Map();
  alteGerichte.forEach(function (g) { neueIds.set(g.id, neueId()); });
  const alteWochen = alteGerichte.length > 0 ? await alleLesen("wochenplan") : [];

  await transaktion(["gerichte", "wochenplan", "haken", "einkauf"], function (s) {
    alteGerichte.forEach(function (g) {
      s.gerichte.delete(g.id);
      s.gerichte.put(Object.assign({}, g, {
        id: neueIds.get(g.id), geloescht: false, aktualisiert: g.geaendert || jetzt, dirty: 1
      }));
    });
    alteWochen.forEach(function (p) {
      s.wochenplan.put({
        woche: p.woche,
        tage: p.tage.map(function (id) { return typeof id === "number" ? (neueIds.get(id) || null) : id; }),
        aktualisiert: jetzt,
        dirty: 1
      });
    });
    alteHaken.forEach(function (e) {
      (e.abgehakt || []).forEach(function (posten) {
        s.haken.put({ id: e.woche + "|" + posten, woche: e.woche, posten: posten, erledigt: true, aktualisiert: jetzt, dirty: 1 });
      });
    });
    s.einkauf.clear();
  });
}

/* ---------- Hilfsfunktionen ---------- */

// Baut ein HTML-Element. Texte werden immer als Text eingesetzt (nie als HTML).
function el(tag, eigenschaften) {
  const e = document.createElement(tag);
  const eig = eigenschaften || {};
  Object.keys(eig).forEach(function (k) {
    const v = eig[k];
    if (v === null || v === undefined || v === false) return;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, v);
  });
  for (let i = 2; i < arguments.length; i++) {
    [].concat(arguments[i]).forEach(function (kind) {
      if (kind === null || kind === undefined || kind === false) return;
      e.append(kind.nodeType ? kind : document.createTextNode(String(kind)));
    });
  }
  return e;
}

// "2,5" oder "2.5" -> 2.5; leer -> null; ungültig -> NaN
function zahlLesen(text) {
  const t = String(text === null || text === undefined ? "" : text).trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

// 2.5 -> "2,5" (ohne Tausenderpunkt, damit es wieder eingelesen werden kann)
function zahlText(n) {
  if (n === null || n === undefined) return "";
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2, useGrouping: false }).format(n);
}

function pluralPortionen(n) { return n === 1 ? "Portion" : "Portionen"; }

// Kohlenhydrat-Stufe eines Gerichts: "" (keine Angabe), "arm" oder "reich"
const KH_TEXT = { arm: "kohlenhydratarm", reich: "kohlenhydratreich" };

// Auswahlleiste zum Filtern. aktuell: "" (alle), "arm" oder "reich".
function khChips(aktuell, beiWahl) {
  const stufen = [["", "Alle"], ["arm", "Kohlenhydratarm"], ["reich", "Kohlenhydratreich"]];
  const leiste = el("div", { class: "chips" });
  function zeichnen(wahl) {
    leiste.replaceChildren.apply(leiste, stufen.map(function (st) {
      return el("button", {
        class: "chip" + (st[0] === wahl ? " aktiv" : ""), type: "button", text: st[1],
        onclick: function () { zeichnen(st[0]); beiWahl(st[0]); }
      });
    }));
  }
  zeichnen(aktuell);
  return leiste;
}
let filterListe = { kh: "", ern: "" };
let suchtextListe = "";

// Ernährungsform eines Gerichts: "" (keine Angabe), "vegetarisch" oder "vegan".
// Vegane Gerichte sind auch vegetarisch und erscheinen deshalb im Filter "Vegetarisch" mit.
const ERN_TEXT = { vegetarisch: "vegetarisch", vegan: "vegan" };

function ernaehrungPasst(g, filter) {
  if (!filter) return true;
  if (filter === "vegan") return g.ernaehrung === "vegan";
  return g.ernaehrung === "vegetarisch" || g.ernaehrung === "vegan";
}

// Trifft ein Gericht Suchtext (Titel oder Zutat) und Filter? zustand: { kh, ern }
function gerichtTrifft(g, zustand, text) {
  const q = (text || "").trim().toLowerCase();
  if (q) {
    const im = g.titel.toLowerCase().indexOf(q) >= 0 ||
      (g.zutaten || []).some(function (z) { return (z.name || "").toLowerCase().indexOf(q) >= 0; });
    if (!im) return false;
  }
  return (!zustand.kh || g.khStufe === zustand.kh) && ernaehrungPasst(g, zustand.ern);
}

const ICON_LUPE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
const ICON_FILTER = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';

// Blatt von unten mit den Filtern (Kohlenhydrate, Ernährung). zustand wird direkt verändert.
function filterBlattOeffnen(zustand, suchtext, beiAenderung) {
  const abdunkeln = el("div", { class: "abdunkeln" });
  const blattEl = el("div", { class: "filterblatt", role: "dialog", "aria-label": "Filter" });
  const fertig = el("button", { class: "knopf knopf-primaer", type: "button" });
  const inhalt = el("div");

  function schliessen() { abdunkeln.remove(); blattEl.remove(); }
  function zaehlen() { return gerichte.filter(function (g) { return gerichtTrifft(g, zustand, suchtext()); }).length; }
  function anzahlAktualisieren() {
    const n = zaehlen();
    fertig.textContent = n === 0 ? "Keine Treffer" : n === 1 ? "1 Gericht anzeigen" : n + " Gerichte anzeigen";
  }
  function geaendert() { anzahlAktualisieren(); beiAenderung(); }
  function aufbauen() {
    inhalt.replaceChildren(
      el("h3", { class: "abschnitt", text: "Kohlenhydrate" }),
      khChips(zustand.kh, function (w) { zustand.kh = w; geaendert(); }),
      el("h3", { class: "abschnitt", text: "Ernährung" }),
      ernChips(zustand.ern, function (w) { zustand.ern = w; geaendert(); })
    );
  }
  abdunkeln.addEventListener("click", schliessen);
  fertig.addEventListener("click", schliessen);
  blattEl.append(
    el("div", { class: "griff" }),
    el("h2", { text: "Filter" }),
    inhalt,
    el("div", { class: "filterfuss" },
      el("button", { class: "knopf knopf-sekundaer", type: "button", text: "Zurücksetzen",
        onclick: function () { zustand.kh = ""; zustand.ern = ""; aufbauen(); geaendert(); } }),
      fertig
    )
  );
  aufbauen();
  anzahlAktualisieren();
  document.body.append(abdunkeln, blattEl);
}

// Suchfeld, Filter-Knopf (mit Zahl der aktiven Filter) und optional der Umschalter Kacheln/Liste.
function suchZeile(optionen) {
  const zustand = optionen.zustand;
  const eingabe = el("input", {
    type: "search", class: "suchfeld-eingabe", autocomplete: "off", autocapitalize: "off",
    placeholder: "Suchen", value: optionen.wert || ""
  });
  const lupe = el("span", { class: "suchfeld-lupe" });
  lupe.innerHTML = ICON_LUPE;
  const zahl = el("span", { class: "zahl", hidden: true });
  const knopf = el("button", { class: "rundknopf", type: "button", "aria-label": "Filter" }, zahl);
  knopf.insertAdjacentHTML("afterbegin", ICON_FILTER);
  function badge() {
    const n = (zustand.kh ? 1 : 0) + (zustand.ern ? 1 : 0);
    zahl.textContent = String(n); zahl.hidden = n === 0;
    knopf.classList.toggle("an", n > 0);
  }
  badge();
  eingabe.addEventListener("input", function () { optionen.beiEingabe(eingabe.value); });
  knopf.addEventListener("click", function () {
    eingabe.blur();
    filterBlattOeffnen(zustand, function () { return eingabe.value; }, function () { badge(); optionen.beiFilter(); });
  });
  return el("div", { class: "suchzeile" },
    el("div", { class: "suchfeld" }, lupe, eingabe),
    knopf,
    optionen.umschalter ? ansichtSchalter() : null
  );
}

function ernChips(aktuell, beiWahl) {
  const stufen = [["", "Alle"], ["vegetarisch", "Vegetarisch"], ["vegan", "Vegan"]];
  const leiste = el("div", { class: "chips" });
  function zeichnen(wahl) {
    leiste.replaceChildren.apply(leiste, stufen.map(function (st) {
      return el("button", {
        class: "chip" + (st[0] === wahl ? " aktiv" : ""), type: "button", text: st[1],
        onclick: function () { zeichnen(st[0]); beiWahl(st[0]); }
      });
    }));
  }
  zeichnen(aktuell);
  return leiste;
}

/* ---------- Zustand ---------- */

let gerichteRoh = new Map(); // alle Gerichte inkl. gelöschter (der Löschmarker wird mit abgeglichen)
let gerichte = [];           // nur die sichtbaren Gerichte
let plaene = new Map();      // Wochenpläne: Schlüssel = Datum des Montags, z. B. "2026-10-19"
let haken = new Map();       // abgehakte Einkaufsposten: Schlüssel = "Woche|Posten"
let extras = new Map();      // eigene Artikel auf der Einkaufsliste: Schlüssel = id (inkl. gelöschter, für Vorschläge)
let extraEntwurf = { name: "", menge: "" }; // halb getippter Artikel bleibt beim Neuzeichnen erhalten

function gerichteAbleiten() {
  gerichte = Array.from(gerichteRoh.values()).filter(function (g) { return !g.geloescht; });
}

// Alle abgehakten Posten einer Woche.
function abgehakteFuer(woche) {
  const menge = new Set();
  haken.forEach(function (h) { if (h.woche === woche && h.erledigt) menge.add(h.posten); });
  return menge;
}

/* ---------- Navigation ---------- */

/* ---------- Suchzeile: haftet oben, verschwindet beim Hinunterscrollen, kommt beim Hinaufscrollen zurück ---------- */

function suchzeileScrollEinrichten() {
  const letzte = new WeakMap();
  // scroll-Ereignisse "blubbern" nicht nach oben, deshalb im Erfassungsmodus am document lauschen.
  document.addEventListener("scroll", function (e) {
    const behaelter = e.target;
    if (!behaelter || !behaelter.querySelector) return;
    const zeile = behaelter.querySelector(".suchzeile");
    if (!zeile) return;
    const jetzt = behaelter.scrollTop;
    const davor = letzte.get(behaelter) || 0;
    const unterschied = jetzt - davor;
    if (jetzt < 40) {
      zeile.classList.remove("weg");
    } else if (unterschied > 6) {
      // Beim Tippen im Suchfeld bleibt die Zeile sichtbar.
      if (!zeile.contains(document.activeElement)) zeile.classList.add("weg");
    } else if (unterschied < -6) {
      zeile.classList.remove("weg");
    }
    if (Math.abs(unterschied) > 6 || jetzt < 40) letzte.set(behaelter, jetzt);
  }, true);
}

function navigationEinrichten() {
  const reiter = document.querySelectorAll("nav button");
  const ansichten = document.querySelectorAll(".ansicht");
  const titel = document.getElementById("titel");
  reiter.forEach(function (knopf) {
    knopf.addEventListener("click", function () {
      // Tipp auf den schon aktiven Reiter: nach oben springen (wie bei iOS-Apps üblich).
      if (knopf.classList.contains("aktiv")) {
        const haupt = document.querySelector("main");
        if (haupt) haupt.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      reiter.forEach(function (k) { k.classList.remove("aktiv"); });
      ansichten.forEach(function (a) { a.classList.remove("aktiv"); });
      knopf.classList.add("aktiv");
      document.getElementById(knopf.dataset.ziel).classList.add("aktiv");
      titel.textContent = knopf.dataset.titel;
    });
  });
}

/* ---------- Vollbild-Ansicht ---------- */

const blatt = document.getElementById("blatt");

function blattZeigen(optionen) {
  const links = optionen.links;
  const rechts = optionen.rechts;
  const kopf = el("div", { class: "blatt-kopf" },
    links ? el("button", { class: "textknopf", type: "button", onclick: links.aktion, text: links.text }) : el("span"),
    el("h2", { class: "blatt-titel", text: optionen.titel }),
    rechts ? el("button", { class: "textknopf fett", type: "button", onclick: rechts.aktion, text: rechts.text }) : el("span")
  );
  const inhalt = el("div", { class: "blatt-inhalt" }, optionen.inhalt);
  blatt.replaceChildren(kopf, inhalt);
  blatt.hidden = false;
}

function blattSchliessen() {
  blatt.hidden = true;
  blatt.replaceChildren();
}

/* ---------- Liste der Gerichte ---------- */

/* ---------- Wischen zum Entfernen (nach links wischen, dann auf den roten Knopf tippen) ---------- */

let offeneWischZeile = null;

function wischZeile(inhalt, beschriftung, beiEntfernen, klasse) {
  const BREITE = 96;
  const aktion = el("button", {
    class: "wisch-aktion", type: "button", tabindex: "-1", text: beschriftung,
    onclick: function () { zumachen(); beiEntfernen(); }
  });
  const huelle = el("div", { class: "wisch" + (klasse ? " " + klasse : "") }, aktion, inhalt);
  let startX = null, startY = 0, startVersatz = 0, versatz = 0, richtung = null, gezogen = false;

  function setzen(wert, weich) {
    versatz = wert;
    inhalt.style.transition = weich ? "transform 0.2s ease" : "none";
    inhalt.style.transform = wert ? "translateX(" + wert + "px)" : "";
    huelle.classList.toggle("offen", wert < 0);
  }
  function zumachen() {
    setzen(0, true);
    if (offeneWischZeile === huelle) offeneWischZeile = null;
  }
  huelle.schliessen = zumachen;

  inhalt.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (offeneWischZeile && offeneWischZeile !== huelle) offeneWischZeile.schliessen();
    startX = e.clientX; startY = e.clientY; startVersatz = versatz; richtung = null; gezogen = false;
  });
  inhalt.addEventListener("pointermove", function (e) {
    if (startX === null) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (richtung === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      richtung = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      if (richtung === "h") { try { inhalt.setPointerCapture(e.pointerId); } catch (x) { /* egal */ } }
    }
    if (richtung !== "h") return;
    gezogen = true;
    setzen(Math.max(-BREITE - 24, Math.min(0, startVersatz + dx)), false);
  });
  function loslassen() {
    if (startX === null) return;
    startX = null;
    if (!gezogen) return;
    if (versatz < -BREITE / 2) {
      setzen(-BREITE, true);
      offeneWischZeile = huelle;
    } else {
      zumachen();
    }
  }
  inhalt.addEventListener("pointerup", loslassen);
  inhalt.addEventListener("pointercancel", loslassen);
  // Nach dem Wischen soll kein Tipp ausgelöst werden; bei geöffneter Zeile schließt ein Tipp sie nur.
  inhalt.addEventListener("click", function (e) {
    if (gezogen) { gezogen = false; e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (versatz < 0) { e.preventDefault(); e.stopImmediatePropagation(); zumachen(); }
  }, true);
  return huelle;
}

/* ---------- Platzhalter für Gerichte ohne Foto: farbiger Kreis, Farbe richtet sich nach dem Titel ---------- */

const KREIS_FARBEN = [
  ["#964632", "#e6a05a"], ["#c88c28", "#f0c85a"], ["#5a788c", "#e69678"], ["#785a32", "#c89650"],
  ["#466e5a", "#aac896"], ["#6e506e", "#d2a0c8"], ["#3c5a82", "#96bee6"], ["#8c3c46", "#e69696"]
];

function kreisBild(titel, klasse) {
  let h = 0;
  for (let i = 0; i < titel.length; i++) h = (h * 31 + titel.charCodeAt(i)) >>> 0;
  const f = KREIS_FARBEN[h % KREIS_FARBEN.length];
  const e = el("div", { class: klasse, "aria-hidden": "true" });
  e.style.background = f[0];
  e.style.position = "relative";
  e.style.overflow = "hidden";
  e.innerHTML = '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="position:absolute;inset:0;width:100%;height:100%">' +
    '<circle cx="50" cy="50" r="31" fill="none" stroke="' + f[1] + '" stroke-width="17"/></svg>';
  return e;
}

/* ---------- Ansicht der Gerichte: Kacheln oder Liste ---------- */

function ansichtLesen() {
  try { return localStorage.getItem("essensplan-ansicht") === "liste" ? "liste" : "kacheln"; } catch (e) { return "kacheln"; }
}
function ansichtSpeichern(a) {
  try { localStorage.setItem("essensplan-ansicht", a); } catch (e) {}
}

const ICON_KACHELN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/></svg>';
const ICON_LISTE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="0.8"/><circle cx="4" cy="12" r="0.8"/><circle cx="4" cy="18" r="0.8"/></svg>';

function ansichtSchalter() {
  const aktuell = ansichtLesen();
  function knopf(art, icon, beschriftung) {
    const k = el("button", {
      class: "ansicht-knopf" + (art === aktuell ? " aktiv" : ""), type: "button", "aria-label": beschriftung,
      onclick: function () { ansichtSpeichern(art); listeZeichnen(); }
    });
    k.innerHTML = icon;
    return k;
  }
  return el("div", { class: "ansicht-schalter" }, knopf("kacheln", ICON_KACHELN, "Kachelansicht"), knopf("liste", ICON_LISTE, "Listenansicht"));
}

const DIAET_ICON = {
  vegetarisch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19c3-4 6-7 10-9"/></svg>',
  vegan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21v-9"/><path d="M12 12c0-4-3-6-7-6 0 4 3 6 7 6z"/><path d="M12 14c0-3 2.5-5 6-5 0 3-2.5 5-6 5z"/></svg>'
};

function gerichtKachel(g) {
  const bild = g.bild
    ? el("img", { class: "kachel-bild", src: g.bild, alt: "", loading: "lazy" })
    : kreisBild(g.titel, "kachel-bild");
  const info = [zahlText(g.portionen) + " Port."];
  if (g.naehrwerte && g.naehrwerte.kcal !== null && g.naehrwerte.kcal !== undefined) info.push(zahlText(g.naehrwerte.kcal) + " kcal");
  const symbol = el("span", { class: "kachel-diaet", title: ERN_TEXT[g.ernaehrung] || "" });
  if (DIAET_ICON[g.ernaehrung]) symbol.innerHTML = DIAET_ICON[g.ernaehrung];
  return el("button", { class: "kachel", type: "button", onclick: function () { detailOeffnen(g.id); } },
    bild,
    el("div", { class: "kachel-text" },
      el("h3", { text: g.titel }),
      el("div", { class: "kachel-fuss" }, el("span", { text: info.join(" · ") }), symbol)
    )
  );
}

function listeZeichnen() {
  const box = document.getElementById("gerichte");
  const sortiert = gerichte.slice().sort(function (a, b) { return a.titel.localeCompare(b.titel, "de"); });
  const teile = [];

  if (sortiert.length === 0) {
    teile.push(el("div", { class: "karte leer" },
      el("div", { class: "leer-symbol", text: "🍽️" }),
      el("h2", { text: "Noch keine Gerichte" }),
      el("p", { text: "Lege dein erstes Gericht an: mit Foto, Zutaten und Nährwerten." })
    ));
  } else {
    const ergebnis = el("div");
    function ergebnisZeichnen() {
      const sichtbar = sortiert.filter(function (g) { return gerichtTrifft(g, filterListe, suchtextListe); });
      const innen = [];
      if (sichtbar.length === 0) {
        const gefiltert = suchtextListe.trim() || filterListe.kh || filterListe.ern;
        innen.push(el("p", { class: "leise", text: gefiltert
          ? "Kein Gericht gefunden. Passe Suche oder Filter an."
          : "Kein Gericht vorhanden." }));
      }
      if (ansichtLesen() === "kacheln") {
        innen.push(el("div", { class: "kachel-raster" }, sichtbar.map(gerichtKachel)));
      } else {
        sichtbar.forEach(function (g) {
          innen.push(wischZeile(gerichtKarte(g), "Löschen", function () { gerichtLoeschen(g); }));
        });
      }
      ergebnis.replaceChildren.apply(ergebnis, innen);
    }
    teile.push(suchZeile({
      zustand: filterListe, wert: suchtextListe, umschalter: true,
      beiEingabe: function (t) { suchtextListe = t; ergebnisZeichnen(); },
      beiFilter: ergebnisZeichnen
    }));
    teile.push(ergebnis);
    ergebnisZeichnen();
  }

  teile.push(el("button", {
    class: "knopf knopf-primaer fab",
    type: "button",
    onclick: function () { formularOeffnen(null); },
    text: "＋ Neues Gericht"
  }));
  box.replaceChildren.apply(box, teile);
}

// beiKlick ist optional: ohne Angabe öffnet ein Tipp die Detailansicht.
function gerichtKarte(g, beiKlick) {
  const bild = g.bild
    ? el("img", { class: "thumb", src: g.bild, alt: "", loading: "lazy" })
    : kreisBild(g.titel, "thumb");

  const meta = [zahlText(g.portionen) + " " + pluralPortionen(g.portionen)];
  if (g.naehrwerte && g.naehrwerte.kcal !== null && g.naehrwerte.kcal !== undefined) {
    meta.push(zahlText(g.naehrwerte.kcal) + " kcal");
  }
  meta.push(g.zutaten.length + (g.zutaten.length === 1 ? " Zutat" : " Zutaten"));
  if (KH_TEXT[g.khStufe]) meta.push(KH_TEXT[g.khStufe]);
  if (ERN_TEXT[g.ernaehrung]) meta.push(ERN_TEXT[g.ernaehrung]);

  return el("button", { class: "gericht-karte", type: "button", onclick: beiKlick || function () { detailOeffnen(g.id); } },
    bild,
    el("div", { class: "gericht-info" },
      el("h3", { text: g.titel }),
      el("p", { text: meta.join(" · ") })
    )
  );
}

/* ---------- Detailansicht ---------- */

function detailOeffnen(id) {
  const g = gerichte.find(function (x) { return x.id === id; });
  if (!g) { blattSchliessen(); return; }

  const n = g.naehrwerte || {};
  const werte = [
    [n.kcal, "kcal", "Kalorien"],
    [n.eiweiss, "g", "Eiweiß"],
    [n.kohlenhydrate, "g", "Kohlenhydrate"],
    [n.fett, "g", "Fett"]
  ];
  const hatNaehrwerte = werte.some(function (w) { return w[0] !== null && w[0] !== undefined; });

  // Portionen-Schalter: rechnet nur die Anzeige um, das gespeicherte Gericht bleibt unverändert.
  let anzeigePortionen = g.portionen;
  const portionenText = el("span", { class: "schritt-text" });
  const portionenHinweis = el("p", { class: "leise schritt-hinweis", hidden: true, text: "Umgerechnet, nur zur Ansicht. Das Gericht selbst bleibt unverändert." });
  const zutatenUl = el("ul", { class: "zutatenliste" });
  function skalierenZeichnen() {
    const faktor = anzeigePortionen / g.portionen;
    portionenText.textContent = "Für " + zahlText(anzeigePortionen) + " " + pluralPortionen(anzeigePortionen);
    portionenHinweis.hidden = anzeigePortionen === g.portionen;
    zutatenUl.replaceChildren.apply(zutatenUl, g.zutaten.map(function (z) {
      const menge = z.menge === null || z.menge === undefined ? "" : zahlText(z.menge * faktor) + " " + z.einheit;
      return el("li", {}, el("span", { text: z.name }), el("span", { text: menge }));
    }));
  }
  function schritt(delta) {
    const neu = anzeigePortionen + delta;
    if (neu < 1 || neu > 99) return;
    anzeigePortionen = neu;
    skalierenZeichnen();
  }
  const portionenSchalter = el("div", {},
    el("div", { class: "schalter" },
      el("button", { class: "schritt", type: "button", "aria-label": "Eine Portion weniger", text: "−", onclick: function () { schritt(-1); } }),
      portionenText,
      el("button", { class: "schritt", type: "button", "aria-label": "Eine Portion mehr", text: "+", onclick: function () { schritt(1); } })
    ),
    portionenHinweis
  );
  skalierenZeichnen();

  const inhalt = [
    g.bild ? el("img", { class: "detail-bild", src: g.bild, alt: g.titel }) : null,
    el("h1", { class: "detail-titel", text: g.titel }),
    (KH_TEXT[g.khStufe] || ERN_TEXT[g.ernaehrung]) ? el("div", { class: "chips-detail" },
      KH_TEXT[g.khStufe] ? el("span", { class: "status", text: KH_TEXT[g.khStufe] }) : null,
      ERN_TEXT[g.ernaehrung] ? el("span", { class: "status", text: ERN_TEXT[g.ernaehrung] }) : null
    ) : null,
    portionenSchalter
  ];

  if (hatNaehrwerte) {
    inhalt.push(el("h3", { class: "abschnitt", text: "Nährwerte pro Portion" }));
    inhalt.push(el("div", { class: "kacheln" }, werte.map(function (w) {
      const text = w[0] === null || w[0] === undefined ? "–" : zahlText(w[0]) + " " + w[1];
      return el("div", { class: "kachel" },
        el("div", { class: "zahl", text: text }),
        el("div", { class: "name", text: w[2] })
      );
    })));
  }

  inhalt.push(el("h3", { class: "abschnitt", text: "Zutaten" }));
  if (g.zutaten.length === 0) {
    inhalt.push(el("p", { class: "leise", text: "Keine Zutaten eingetragen." }));
  } else {
    inhalt.push(zutatenUl);
  }

  if (g.notizen) {
    inhalt.push(el("h3", { class: "abschnitt", text: "Notizen" }));
    inhalt.push(el("p", { class: "notizen", text: g.notizen }));
  }

  inhalt.push(el("div", { class: "reihe", style: "margin-top: 28px" },
    el("button", { class: "knopf knopf-primaer", type: "button", onclick: function () { formularOeffnen(g); }, text: "Bearbeiten" }),
    el("button", { class: "knopf knopf-sekundaer", type: "button", onclick: function () { gerichtKopieren(g); }, text: "Kopieren" })
  ));
  inhalt.push(el("div", { class: "reihe" },
    el("button", { class: "knopf knopf-gefahr", type: "button", onclick: function () { gerichtLoeschen(g); }, text: "Löschen" })
  ));

  blattZeigen({
    titel: "Gericht",
    links: { text: "Schließen", aktion: blattSchliessen },
    inhalt: inhalt
  });
}

// Öffnet das Formular mit einer Kopie des Gerichts. Gespeichert wird erst, wenn man auf "Speichern" tippt.
function gerichtKopieren(g) {
  const kopie = JSON.parse(JSON.stringify(g));
  delete kopie.id; delete kopie.erstellt; delete kopie.geaendert; delete kopie.aktualisiert;
  delete kopie.geloescht; delete kopie.version;
  kopie.titel = g.titel + " (Kopie)";
  formularOeffnen(kopie);
}

async function gerichtLoeschen(g) {
  if (!confirm("„" + g.titel + "“ wirklich löschen?")) return;
  // Das Gericht wird nur als gelöscht markiert, damit das Löschen auch auf die anderen Geräte kommt.
  const jetzt = Date.now();
  const grab = Object.assign({}, g, {
    bild: null, zutaten: [], geloescht: true, geaendert: jetzt, aktualisiert: zeitNach(g), dirty: 1
  });
  try {
    await schreiben("gerichte", function (s) { return s.put(grab); });
    await gerichteNeuLaden();
    blattSchliessen();
    syncAnstossen();
  } catch (fehler) {
    alert("Das Löschen hat leider nicht geklappt.");
  }
}

/* ---------- Formular: Gericht anlegen / bearbeiten ---------- */

// Verkleinert ein Foto auf max. 800 Pixel Kantenlänge, damit Speicher und Abgleich schnell bleiben.
function bildVerkleinern(datei) {
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(datei);
    const bild = new Image();
    bild.onload = function () {
      const faktor = Math.min(1, 800 / Math.max(bild.naturalWidth, bild.naturalHeight));
      const breite = Math.max(1, Math.round(bild.naturalWidth * faktor));
      const hoehe = Math.max(1, Math.round(bild.naturalHeight * faktor));
      const leinwand = document.createElement("canvas");
      leinwand.width = breite;
      leinwand.height = hoehe;
      leinwand.getContext("2d").drawImage(bild, 0, 0, breite, hoehe);
      URL.revokeObjectURL(url);
      resolve(leinwand.toDataURL("image/jpeg", 0.72));
    };
    bild.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error("Bild konnte nicht gelesen werden"));
    };
    bild.src = url;
  });
}

function formularOeffnen(gericht) {
  const neu = !gericht || !gericht.id;
  const g = gericht || {
    titel: "",
    bild: null,
    portionen: 2,
    zutaten: [{ name: "", menge: null, einheit: "g" }],
    naehrwerte: { kcal: null, eiweiss: null, kohlenhydrate: null, fett: null },
    notizen: ""
  };
  const n = g.naehrwerte || {};
  let bild = g.bild || null;
  let speichertGerade = false;

  const zurueck = function () { if (neu) blattSchliessen(); else detailOeffnen(g.id); };

  const fehler = el("p", { class: "fehler", hidden: true });
  function fehlerMelden(text, feld) {
    fehler.textContent = text;
    fehler.hidden = false;
    fehler.scrollIntoView({ block: "center" });
    if (feld) feld.focus();
  }

  // Titel und Portionen
  const titelFeld = el("input", {
    type: "text", class: "eingabe", maxlength: "80", autocomplete: "off",
    autocapitalize: "sentences", placeholder: "z. B. Gemüsepfanne mit Reis", value: g.titel
  });
  const portionenFeld = el("input", {
    type: "text", class: "eingabe", inputmode: "numeric", autocomplete: "off", value: zahlText(g.portionen)
  });

  const khStufeFeld = el("select", { class: "eingabe" },
    el("option", { value: "", text: "Keine Angabe" }),
    el("option", { value: "arm", text: "Kohlenhydratarm" }),
    el("option", { value: "reich", text: "Kohlenhydratreich" })
  );
  khStufeFeld.value = g.khStufe === "arm" || g.khStufe === "reich" ? g.khStufe : "";

  const ernaehrungFeld = el("select", { class: "eingabe" },
    el("option", { value: "", text: "Keine Angabe" }),
    el("option", { value: "vegetarisch", text: "Vegetarisch" }),
    el("option", { value: "vegan", text: "Vegan" })
  );
  ernaehrungFeld.value = g.ernaehrung === "vegetarisch" || g.ernaehrung === "vegan" ? g.ernaehrung : "";

  // Ändert man die Portionen, rechnen sich alle Mengen proportional um.
  let letztePortionen = zahlLesen(portionenFeld.value);
  portionenFeld.addEventListener("change", function () {
    const neu = zahlLesen(portionenFeld.value);
    if (neu === null || Number.isNaN(neu) || neu <= 0) return;
    if (letztePortionen !== null && !Number.isNaN(letztePortionen) && letztePortionen > 0 && neu !== letztePortionen) {
      const faktor = neu / letztePortionen;
      zutatenListe.querySelectorAll(".z-menge").forEach(function (feld) {
        const m = zahlLesen(feld.value);
        if (m !== null && !Number.isNaN(m)) feld.value = zahlText(m * faktor);
      });
    }
    letztePortionen = neu;
  });

  // Foto
  const bildBereich = el("div");
  const dateiFeld = el("input", { type: "file", accept: "image/*", hidden: true });
  function bildZeichnen() {
    if (bild) {
      bildBereich.replaceChildren(
        el("img", { class: "form-bild", src: bild, alt: "Vorschau" }),
        el("div", { class: "reihe" },
          el("button", { class: "knopf knopf-sekundaer", type: "button", onclick: function () { dateiFeld.click(); }, text: "Foto ändern" }),
          el("button", { class: "knopf knopf-sekundaer", type: "button", onclick: function () { bild = null; bildZeichnen(); }, text: "Foto entfernen" })
        )
      );
    } else {
      bildBereich.replaceChildren(
        el("button", { class: "foto-knopf", type: "button", onclick: function () { dateiFeld.click(); }, text: "📷 Foto hinzufügen" })
      );
    }
  }
  dateiFeld.addEventListener("change", async function () {
    const datei = dateiFeld.files[0];
    dateiFeld.value = "";
    if (!datei) return;
    try {
      bild = await bildVerkleinern(datei);
      bildZeichnen();
    } catch (f) {
      fehlerMelden("Das Foto konnte nicht geladen werden. Bitte versuche ein anderes.");
    }
  });
  bildZeichnen();

  // Zutaten
  const zutatenListe = el("div");
  function zutatZeile(z) {
    const name = el("input", {
      type: "text", class: "eingabe z-name", list: "zutatenvorschlaege", autocomplete: "off",
      autocapitalize: "sentences", placeholder: "Zutat, z. B. Milch", value: z.name
    });
    const menge = el("input", {
      type: "text", class: "eingabe z-menge", inputmode: "decimal", autocomplete: "off",
      placeholder: "Menge", value: zahlText(z.menge)
    });
    const einheit = el("select", { class: "eingabe z-einheit" }, EINHEITEN.map(function (e) {
      return el("option", { value: e, text: e });
    }));
    einheit.value = EINHEITEN.indexOf(z.einheit) >= 0 ? z.einheit : "g";
    const zeile = el("div", { class: "zutat" },
      name,
      el("div", { class: "zutat-zeile2" },
        menge,
        einheit,
        el("button", { class: "entfernen", type: "button", "aria-label": "Zutat entfernen", onclick: function () { zeile.remove(); }, text: "✕" })
      )
    );
    return zeile;
  }
  g.zutaten.forEach(function (z) { zutatenListe.append(zutatZeile(z)); });
  const zutatHinzufuegen = el("button", {
    class: "knopf knopf-sekundaer", type: "button", style: "width: 100%",
    onclick: function () {
      const zeile = zutatZeile({ name: "", menge: null, einheit: "g" });
      zutatenListe.append(zeile);
      zeile.querySelector(".z-name").focus();
    },
    text: "＋ Zutat hinzufügen"
  });

  // Nährwerte
  function zahlFeld(beschriftung, wert) {
    const eingabe = el("input", {
      type: "text", class: "eingabe", inputmode: "decimal", autocomplete: "off", value: zahlText(wert)
    });
    return { eingabe: eingabe, feld: el("label", { class: "feld" }, el("span", { text: beschriftung }), eingabe) };
  }
  const kcal = zahlFeld("Kalorien (kcal)", n.kcal);
  const eiweiss = zahlFeld("Eiweiß (g)", n.eiweiss);
  const kh = zahlFeld("Kohlenhydrate (g)", n.kohlenhydrate);
  const fett = zahlFeld("Fett (g)", n.fett);

  const notizenFeld = el("textarea", {
    class: "eingabe", placeholder: "Zubereitung, Tipps, Varianten …"
  });
  notizenFeld.value = g.notizen || "";

  // Speichern
  async function speichern() {
    if (speichertGerade) return;
    fehler.hidden = true;

    const titel = titelFeld.value.trim();
    if (!titel) return fehlerMelden("Bitte gib einen Titel ein.", titelFeld);

    const portionen = zahlLesen(portionenFeld.value);
    if (portionen === null || Number.isNaN(portionen) || portionen <= 0) {
      return fehlerMelden("Bitte gib die Anzahl der Portionen als Zahl an (mindestens 1).", portionenFeld);
    }

    const zutaten = [];
    const zeilen = zutatenListe.querySelectorAll(".zutat");
    for (let i = 0; i < zeilen.length; i++) {
      const nameFeld = zeilen[i].querySelector(".z-name");
      const mengeFeld = zeilen[i].querySelector(".z-menge");
      const name = nameFeld.value.trim();
      if (!name && mengeFeld.value.trim() === "") continue; // leere Zeile ignorieren
      if (!name) return fehlerMelden("Bei einer Zutat fehlt der Name.", nameFeld);
      const menge = zahlLesen(mengeFeld.value);
      if (Number.isNaN(menge)) {
        return fehlerMelden("Die Menge bei „" + name + "“ ist keine gültige Zahl (z. B. 2,5).", mengeFeld);
      }
      zutaten.push({ name: name, menge: menge, einheit: zeilen[i].querySelector(".z-einheit").value });
    }

    const werte = {};
    const felder = [["kcal", kcal], ["eiweiss", eiweiss], ["kohlenhydrate", kh], ["fett", fett]];
    for (let i = 0; i < felder.length; i++) {
      const wert = zahlLesen(felder[i][1].eingabe.value);
      if (Number.isNaN(wert)) return fehlerMelden("Nährwerte bitte nur als Zahl eingeben (z. B. 12,5).", felder[i][1].eingabe);
      werte[felder[i][0]] = wert;
    }

    const jetzt = Date.now();
    const datensatz = {
      id: g.id || neueId(),
      titel: titel,
      bild: bild,
      portionen: portionen,
      zutaten: zutaten,
      naehrwerte: werte,
      khStufe: khStufeFeld.value,
      ernaehrung: ernaehrungFeld.value,
      notizen: notizenFeld.value.trim(),
      erstellt: g.erstellt || jetzt,
      geaendert: jetzt,
      aktualisiert: zeitNach(g),
      geloescht: false,
      dirty: 1
    };

    speichertGerade = true;
    try {
      const id = await schreiben("gerichte", function (s) { return s.put(datensatz); });
      await gerichteNeuLaden();
      syncAnstossen();
      if (neu) blattSchliessen(); else detailOeffnen(id);
    } catch (f) {
      speichertGerade = false;
      fehlerMelden("Das Speichern hat nicht geklappt. Eventuell ist der Speicher voll oder das Foto zu groß.");
    }
  }

  blattZeigen({
    titel: neu ? "Neues Gericht" : "Gericht bearbeiten",
    links: { text: "Abbrechen", aktion: zurueck },
    rechts: { text: "Speichern", aktion: speichern },
    inhalt: [
      neu ? importKarte(function (importiert) { formularOeffnen(importiert); }) : null,
      el("label", { class: "feld" }, el("span", { text: "Titel" }), titelFeld),
      el("div", { class: "feld" }, el("span", { text: "Foto (optional)" }), bildBereich, dateiFeld),
      el("label", { class: "feld" }, el("span", { text: "Anzahl Portionen (Mengen rechnen sich automatisch um)" }), portionenFeld),
      el("label", { class: "feld" }, el("span", { text: "Kohlenhydrate (für den Filter bei Sport- und Ruhetagen)" }), khStufeFeld),
      el("label", { class: "feld" }, el("span", { text: "Ernährung (für den Filter nach vegetarisch oder vegan)" }), ernaehrungFeld),
      el("h3", { class: "abschnitt", text: "Zutaten" }),
      zutatenListe,
      zutatHinzufuegen,
      el("h3", { class: "abschnitt", text: "Nährwerte pro Portion" }),
      el("div", { class: "zweispaltig" }, kcal.feld, eiweiss.feld, kh.feld, fett.feld),
      el("label", { class: "feld" }, el("span", { text: "Notizen (optional)" }), notizenFeld),
      fehler,
      el("button", { class: "knopf knopf-primaer", type: "button", style: "width: 100%", onclick: speichern, text: "Speichern" })
    ]
  });
  if (neu && !g.titel) titelFeld.focus();
}

/* ---------- Rezept aus einem Link importieren ---------- */

const IMPORT_EINHEITEN = {
  g: "g", gr: "g", gramm: "g", kg: "kg", ml: "ml", l: "l", liter: "l",
  el: "EL", esslöffel: "EL", tl: "TL", teelöffel: "TL",
  dose: "Dose", dosen: "Dose", bund: "Bund", prise: "Prise", prisen: "Prise",
  pck: "Packung", pkg: "Packung", päckchen: "Packung", packung: "Packung", packungen: "Packung",
  stück: "Stück", stk: "Stück", st: "Stück"
};
const IMPORT_BRUCH = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };

// "800 g Rinderhackfleisch" -> { name: "Rinderhackfleisch", menge: 800, einheit: "g", hinweis: "" }
function zutatZerlegen(zeile) {
  let t = String(zeile).replace(/\s+/g, " ").trim();
  const hinweise = [];
  t = t.replace(/\(([^)]*)\)/g, function (_, h) { if (h.trim()) hinweise.push(h.trim()); return " "; });
  t = t.replace(/\s*Abtropfgewicht.*$/i, function (m) { hinweise.push(m.trim()); return ""; });
  t = t.replace(/^(ca\.?|etwa|circa)\s+/i, "").replace(/\s+/g, " ").trim();
  let menge = null;
  let m = t.match(/^(\d+)\s*([½¼¾⅓⅔])/) || t.match(/^()([½¼¾⅓⅔])/);
  if (m) {
    menge = (m[1] ? Number(m[1]) : 0) + IMPORT_BRUCH[m[2]];
    t = t.slice(m[0].length).trim();
  } else if ((m = t.match(/^(\d+)\s+(\d+)\/(\d+)(?=\s|$)/))) {
    menge = Number(m[1]) + Number(m[2]) / Number(m[3]);
    t = t.slice(m[0].length).trim();
  } else if ((m = t.match(/^(\d+)\/(\d+)(?=\s|$)/))) {
    menge = Number(m[1]) / Number(m[2]);
    t = t.slice(m[0].length).trim();
  } else if ((m = t.match(/^(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?/))) {
    menge = Number(m[1].replace(",", "."));
    t = t.slice(m[0].length).trim();
  }
  let einheit = "g";
  if (menge !== null) {
    einheit = "Stück";
    const w = t.match(/^(\S+)\s*(.*)$/);
    if (w) {
      const schluessel = w[1].replace(/\.$/, "").toLowerCase();
      if (IMPORT_EINHEITEN[schluessel]) { einheit = IMPORT_EINHEITEN[schluessel]; t = w[2]; }
    }
  }
  t = t.replace(/\s+(Dose|Packung|Glas)$/i, function (_, w) { hinweise.push(w); return ""; });
  const name = t.replace(/^(von|vom)\s+/i, "").replace(/^[-–,\s]+|[,\s]+$/g, "").trim() || String(zeile).trim();
  return { name: name, menge: menge === null ? null : Math.round(menge * 100) / 100, einheit: einheit, hinweis: hinweise.join(", ") };
}

// Macht aus der Antwort des Importhelfers ein Gericht, das im Formular geöffnet werden kann.
function rezeptZuGericht(r) {
  const zutaten = [];
  const hinweise = [];
  (r.zutaten || []).forEach(function (zeile) {
    const z = zutatZerlegen(zeile);
    zutaten.push({ name: z.name, menge: z.menge, einheit: z.einheit });
    if (z.hinweis) hinweise.push("- " + z.name + ": " + z.hinweis);
  });
  const teile = [];
  const zeit = r.zeiten || {};
  const zeiten = [];
  if (zeit.vorbereiten) zeiten.push("Zubereitung " + zeit.vorbereiten + " Min");
  if (zeit.kochen) zeiten.push("Kochen " + zeit.kochen + " Min");
  if (zeit.gesamt) zeiten.push("Gesamt " + zeit.gesamt + " Min");
  if (zeiten.length) teile.push(zeiten.join(" · "));
  if ((r.schritte || []).length) {
    let nr = 0;
    teile.push(r.schritte.map(function (st) {
      if (st.indexOf("## ") === 0) return st.slice(3) + ":";
      nr++;
      return nr + ". " + st;
    }).join("\n"));
  }
  if (hinweise.length) teile.push("Hinweise zu Zutaten:\n" + hinweise.join("\n"));
  if (r.quelle) teile.push("Quelle: " + r.quelle);
  const n = r.naehrwerte || {};
  return {
    titel: String(r.titel || "").slice(0, 80),
    bild: r.bildNeu || null,
    portionen: r.portionen && r.portionen > 0 ? r.portionen : 2,
    zutaten: zutaten.length ? zutaten : [{ name: "", menge: null, einheit: "g" }],
    naehrwerte: { kcal: n.kcal === undefined ? null : n.kcal, eiweiss: n.eiweiss === undefined ? null : n.eiweiss,
      kohlenhydrate: n.kohlenhydrate === undefined ? null : n.kohlenhydrate, fett: n.fett === undefined ? null : n.fett },
    notizen: teile.join("\n\n")
  };
}

// Ruft den Importhelfer in Supabase auf. Liefert das fertige Gericht oder wirft eine Fehlermeldung als Text.
async function rezeptHolen(adresse) {
  if (!sb || !sbSitzung) throw new Error("Für den Import musst du angemeldet sein (Wolken-Knopf oben).");
  let antwort;
  try {
    antwort = await sb.functions.invoke("rezept-import", { body: { url: adresse } });
  } catch (f) {
    throw new Error("Der Import hat keine Verbindung bekommen. Bist du online?");
  }
  if (antwort.error) {
    let code = "";
    try { code = (await antwort.error.context.json()).fehler; } catch (e) {}
    if (code === "kein-rezept") throw new Error("Auf dieser Seite habe ich kein Rezept gefunden. Du kannst das Gericht von Hand anlegen.");
    if (code === "adresse") throw new Error("Das ist keine gültige Internetadresse.");
    if (code === "abruf") throw new Error("Die Seite konnte nicht geladen werden (vielleicht blockiert sie den Abruf).");
    if (code === "anmelden") throw new Error("Bitte melde dich neu an (Wolken-Knopf oben).");
    throw new Error("Der Import hat leider nicht geklappt.");
  }
  const r = antwort.data && antwort.data.rezept;
  if (!r) throw new Error("Der Import hat leider nicht geklappt.");
  if (r.bild) {
    try {
      const blob = await (await fetch(r.bild)).blob();
      r.bildNeu = await bildVerkleinern(new File([blob], "rezept.jpg", { type: blob.type || "image/jpeg" }));
    } catch (e) { r.bildNeu = null; }
  }
  return rezeptZuGericht(r);
}

function importKarte(beiErfolg) {
  const feld = el("input", { type: "url", class: "eingabe", placeholder: "https://…", autocomplete: "off", autocapitalize: "off", inputmode: "url" });
  const meldung = el("p", { class: "leise", hidden: true });
  const knopf = el("button", { class: "knopf knopf-sekundaer", type: "button", style: "width: 100%", text: "Importieren" });
  knopf.addEventListener("click", async function () {
    const adresse = feld.value.trim();
    if (!adresse) { meldung.textContent = "Bitte füge zuerst einen Link ein."; meldung.hidden = false; return; }
    knopf.disabled = true; knopf.textContent = "Lade Rezept …"; meldung.hidden = true;
    try {
      beiErfolg(await rezeptHolen(adresse));
    } catch (f) {
      meldung.textContent = f.message; meldung.hidden = false;
      knopf.disabled = false; knopf.textContent = "Importieren";
    }
  });
  return el("div", { class: "karte import-karte" },
    el("h3", { class: "abschnitt", style: "margin-top: 0", text: "Rezept aus Link importieren" }),
    el("p", { class: "leise", text: "Link einer Rezeptseite einfügen. Titel, Zutaten, Anleitung (unter Notizen), Nährwerte und Foto werden übernommen." }),
    feld, el("div", { style: "height: 8px" }), knopf, meldung
  );
}

/* ---------- Wochenplaner ---------- */

const TAGNAMEN = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"];
const TAGKURZ = ["Mo", "Di", "Mi", "Do", "Fr"];

// Datum um n Tage verschieben (immer mittags, damit die Sommerzeit nichts verschiebt).
function tagVerschieben(datum, tage) {
  return new Date(datum.getFullYear(), datum.getMonth(), datum.getDate() + tage, 12);
}

function montagVon(datum) {
  return tagVerschieben(datum, -((datum.getDay() + 6) % 7));
}

function datumSchluessel(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function kurzDatum(d) {
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + ".";
}

// Kalenderwoche nach ISO 8601 (die Woche gehört zu dem Jahr, in dem ihr Donnerstag liegt).
function kalenderwoche(montag) {
  const donnerstag = tagVerschieben(montag, 3);
  const jahresanfang = new Date(donnerstag.getFullYear(), 0, 1, 12);
  const tagImJahr = Math.round((donnerstag - jahresanfang) / 86400000);
  return Math.floor(tagImJahr / 7) + 1;
}

// Am Wochenende wird meistens die kommende Woche geplant, daher startet die App dann dort.
function standardWoche() {
  const heute = new Date();
  const montag = montagVon(heute);
  return (heute.getDay() + 6) % 7 >= 5 ? tagVerschieben(montag, 7) : montag;
}

let angezeigteWoche = standardWoche();

function wocheWechseln(richtung) {
  angezeigteWoche = tagVerschieben(angezeigteWoche, 7 * richtung);
  wochenAnsichtenZeichnen();
}

/* ---------- Wischen von Woche zu Woche ----------
   Nach links wischen = nächste Woche, nach rechts = vorige. Es gilt nur auf dem Wochenkopf und der freien Fläche;
   auf den Tageskarten und Einkaufsposten bleibt das Wischen zum Entfernen unberührt. */

function wochenWischenEinrichten() {
  const haupt = document.querySelector("main");
  const geschuetzt = ".tag, .wisch, .posten-liste, .vorschlag-liste, .extra-form, input, select, textarea";
  let start = null, waagerecht = false, behaelter = null, dx = 0;

  function aktiv() { return document.querySelector(".ansicht.aktiv"); }
  function imWochenBereich() { const a = aktiv(); return a && (a.id === "wochenplan" || a.id === "einkauf") ? a : null; }

  haupt.addEventListener("pointerdown", function (e) {
    start = null; waagerecht = false; dx = 0;
    behaelter = imWochenBereich();
    if (!behaelter || !e.isPrimary) return;
    if (e.target.closest(geschuetzt)) return;
    // Knöpfe nur im Wochenkopf zulassen (die Pfeile), sonst würde ein Tipp auf einen Knopf als Wischen zählen.
    if (e.target.closest("button") && !e.target.closest(".woche-kopf")) return;
    start = { x: e.clientX, y: e.clientY };
  });

  haupt.addEventListener("pointermove", function (e) {
    if (!start || !behaelter) return;
    const x = e.clientX - start.x, y = e.clientY - start.y;
    if (!waagerecht) {
      if (Math.abs(y) > 12 && Math.abs(y) > Math.abs(x)) { start = null; return; }
      if (Math.abs(x) > 12 && Math.abs(x) > Math.abs(y) * 1.5) waagerecht = true; else return;
    }
    dx = x;
    behaelter.style.transition = "none";
    behaelter.style.transform = "translateX(" + Math.round(dx * 0.35) + "px)";
    behaelter.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 420));
  });

  function loslassen() {
    if (!start || !behaelter) { start = null; return; }
    const b = behaelter;
    const war = waagerecht, weite = dx;
    start = null; waagerecht = false;
    if (!war) return;
    wischGerade = true;
    setTimeout(function () { wischGerade = false; }, 60);
    const richtung = weite < 0 ? 1 : -1;
    const kurz = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (Math.abs(weite) < 70) {
      b.style.transition = "transform .15s, opacity .15s"; b.style.transform = ""; b.style.opacity = "";
      return;
    }
    if (kurz) { b.style.transition = ""; b.style.transform = ""; b.style.opacity = ""; wocheWechseln(richtung); return; }
    b.style.transition = "transform .14s ease-in, opacity .14s ease-in";
    b.style.transform = "translateX(" + (-richtung * 60) + "px)";
    b.style.opacity = "0";
    setTimeout(function () {
      wocheWechseln(richtung);
      b.style.transition = "none";
      b.style.transform = "translateX(" + (richtung * 60) + "px)";
      b.style.opacity = "0";
      void b.offsetWidth;
      b.style.transition = "transform .18s ease-out, opacity .18s ease-out";
      b.style.transform = ""; b.style.opacity = "";
    }, 140);
  }
  haupt.addEventListener("pointerup", loslassen);
  haupt.addEventListener("pointercancel", loslassen);
  // Nach einem Wisch soll der Knopf, auf dem der Finger endet, nicht zusätzlich auslösen.
  haupt.addEventListener("click", function (e) {
    if (wischGerade) { wischGerade = false; e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
let wischGerade = false;

// Wochenplan und Einkaufsliste zeigen immer dieselbe Woche.
function wochenAnsichtenZeichnen() {
  wochenplanZeichnen();
  einkaufZeichnen();
}

// Kopfzeile mit Blätter-Pfeilen, in Wochenplan und Einkaufsliste identisch.
function wochenKopf() {
  const montag = angezeigteWoche;
  const freitag = tagVerschieben(montag, 4);
  const standard = standardWoche();
  const teile = [el("div", { class: "woche-kopf" },
    el("button", { class: "pfeil", type: "button", "aria-label": "Vorherige Woche", onclick: function () { wocheWechseln(-1); }, text: "‹" }),
    el("div", { class: "woche-titel" },
      el("div", { class: "woche-kw", text: "KW " + kalenderwoche(montag) }),
      el("div", { class: "woche-datum", text: kurzDatum(montag) + " – " + kurzDatum(freitag) + freitag.getFullYear() })
    ),
    el("button", { class: "pfeil", type: "button", "aria-label": "Nächste Woche", onclick: function () { wocheWechseln(1); }, text: "›" })
  )];
  const aktionen = el("div", { class: "woche-aktionen" });
  if (datumSchluessel(montag) !== datumSchluessel(standard)) {
    aktionen.append(el("button", {
      class: "textknopf", type: "button",
      onclick: function () { angezeigteWoche = standardWoche(); wochenAnsichtenZeichnen(); },
      text: "Zu KW " + kalenderwoche(standard)
    }));
  }
  aktionen.append(el("button", {
    class: "textknopf", type: "button", onclick: function () { planTeilenOeffnen(); }
  }, teilenIconKnoten(), " Plan teilen"));
  teile.push(aktionen);
  return teile;
}

function kurzInfo(g) {
  const teile = [zahlText(g.portionen) + " " + pluralPortionen(g.portionen)];
  if (g.naehrwerte && g.naehrwerte.kcal !== null && g.naehrwerte.kcal !== undefined) {
    teile.push(zahlText(g.naehrwerte.kcal) + " kcal");
  }
  if (KH_TEXT[g.khStufe]) teile.push(KH_TEXT[g.khStufe]);
  if (ERN_TEXT[g.ernaehrung]) teile.push(ERN_TEXT[g.ernaehrung]);
  return teile.join(" · ");
}

function wochenplanZeichnen() {
  const box = document.getElementById("wochenplan");
  const montag = angezeigteWoche;
  const plan = plaene.get(datumSchluessel(montag));
  const heute = datumSchluessel(new Date());
  const teile = wochenKopf();

  for (let i = 0; i < 5; i++) {
    const tag = tagVerschieben(montag, i);
    const id = plan ? plan.tage[i] : null;
    // Wurde ein Gericht inzwischen gelöscht, erscheint der Tag wieder als leer.
    const g = id === null || id === undefined ? null : gerichte.find(function (x) { return x.id === id; });
    teile.push(tagKarte(i, tag, g || null, datumSchluessel(tag) === heute, sportTage(plan)[i], id === AUSWAERTS));
  }
  box.replaceChildren.apply(box, teile);
}

const AUSWAERTS = "auswaerts";
const AUSWAERTS_PFAD = "M6 3v6a2 2 0 0 0 4 0V3M8 3v18M16 21V3c-2 2-3 5-3 8h3";
const AUSWAERTS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + AUSWAERTS_PFAD + '"/></svg>';

function tagKarte(index, tag, g, istHeute, istSport, auswaerts) {
  let inhalt;
  if (auswaerts) {
    const kreis = el("div", { class: "thumb klein auswaerts-kreis", "aria-hidden": "true" });
    kreis.innerHTML = AUSWAERTS_ICON;
    inhalt = [kreis, el("div", { class: "gericht-info" }, el("h3", { text: "Auswärts essen" }), el("p", { text: "Kein Gericht geplant" }))];
  } else if (g) {
    inhalt = [
      g.bild
        ? el("img", { class: "thumb klein", src: g.bild, alt: "", loading: "lazy" })
        : kreisBild(g.titel, "thumb klein"),
      el("div", { class: "gericht-info" }, el("h3", { text: g.titel }), el("p", { text: kurzInfo(g) }))
    ];
  } else {
    inhalt = [el("span", { class: "tag-leer", text: "＋ Gericht wählen" })];
  }
  const karte = el("button", {
    class: "tag" + (istHeute ? " heute" : ""), type: "button", "aria-label": TAGNAMEN[index],
    onclick: function () { gerichtWaehlen(index, auswaerts ? AUSWAERTS : (g ? g.id : null)); }
  },
    el("div", { class: "tag-datum" },
      el("div", { class: "name", text: TAGKURZ[index] }),
      el("div", { class: "datum", text: kurzDatum(tag) })
    ),
    el("div", { class: "tag-inhalt" }, inhalt)
  );
  if (istSport) {
    const badge = el("span", { class: "sport-badge", title: "Sporttag" });
    badge.innerHTML = SPORT_ICON;
    karte.appendChild(badge);
    karte.setAttribute("aria-label", TAGNAMEN[index] + ", Sporttag");
  }
  langDruck(karte, function () { sportUmschalten(angezeigteWoche, index); });
  if (!g && !auswaerts) return karte;
  return wischZeile(karte, "Entfernen", function () { tagSetzen(angezeigteWoche, index, null); });
}

// Zeigt die Gerichte zur Auswahl für einen Tag der gerade angezeigten Woche.
function gerichtWaehlen(index, aktuelleId) {
  const montag = angezeigteWoche;
  const tag = tagVerschieben(montag, index);
  const liste = el("div", { style: "margin-top: 14px" });
  const auswahlFilter = { kh: "", ern: "" };
  let suchtext = "";
  const kopfzeile = suchZeile({
    zustand: auswahlFilter, wert: "", umschalter: false,
    beiEingabe: function (t) { suchtext = t; listeZeichnen2(); },
    beiFilter: function () { listeZeichnen2(); }
  });

  function listeZeichnen2() {
    const treffer = gerichte
      .filter(function (g) { return gerichtTrifft(g, auswahlFilter, suchtext); })
      .sort(function (a, b) { return a.titel.localeCompare(b.titel, "de"); });
    if (gerichte.length === 0) {
      liste.replaceChildren(el("div", { class: "karte" },
        el("p", { text: "Du hast noch keine Gerichte angelegt. Lege sie zuerst im Reiter „Gerichte“ an." })));
    } else if (treffer.length === 0) {
      liste.replaceChildren(el("p", { class: "leise", text: "Kein Gericht gefunden." }));
    } else {
      liste.replaceChildren.apply(liste, treffer.map(function (g) {
        return gerichtKarte(g, function () { tagSetzen(montag, index, g.id); });
      }));
    }
  }
  listeZeichnen2();

  const auswaertsIcon = el("div", { class: "thumb klein auswaerts-kreis", "aria-hidden": "true" });
  auswaertsIcon.innerHTML = AUSWAERTS_ICON;
  const auswaertsKnopf = el("button", {
    class: "karte auswaerts-wahl" + (aktuelleId === AUSWAERTS ? " aktiv" : ""), type: "button",
    onclick: function () { tagSetzen(montag, index, AUSWAERTS); }
  }, auswaertsIcon, el("div", { class: "gericht-info" }, el("h3", { text: "Auswärts essen" }), el("p", { text: "Kein Gericht an diesem Tag" })));

  blattZeigen({
    titel: TAGNAMEN[index] + ", " + kurzDatum(tag),
    links: { text: "Abbrechen", aktion: blattSchliessen },
    inhalt: [
      auswaertsKnopf,
      gerichte.length > 0 ? kopfzeile : null,
      liste,
      aktuelleId !== null && aktuelleId !== undefined
        ? el("button", {
            class: "knopf knopf-gefahr", type: "button", style: "width: 100%; margin-top: 8px",
            onclick: function () { tagSetzen(montag, index, null); },
            text: aktuelleId === AUSWAERTS ? "Auswärts essen entfernen" : "Gericht für diesen Tag entfernen"
          })
        : null
    ]
  });
}

// Welche Tage der Woche Sporttage sind (immer eine Liste mit 5 Einträgen, wahr oder falsch).
function sportTage(plan) {
  const liste = plan && Array.isArray(plan.sport) ? plan.sport : [];
  return [0, 1, 2, 3, 4].map(function (i) { return liste[i] === true; });
}

const SPORT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/></svg>';

// Langes Drücken auf einen Tag: Sport-Badge an oder aus.
async function sportUmschalten(montag, index) {
  const schluessel = datumSchluessel(montag);
  const alt = plaene.get(schluessel);
  const sport = sportTage(alt);
  sport[index] = !sport[index];
  const plan = {
    woche: schluessel,
    tage: alt ? alt.tage.slice() : [null, null, null, null, null],
    sport: sport,
    aktualisiert: zeitNach(alt),
    dirty: 1
  };
  try {
    await schreiben("wochenplan", function (st) { return st.put(plan); });
    await plaeneNeuLaden();
    syncAnstossen();
  } catch (fehler) {
    alert("Das Speichern hat leider nicht geklappt.");
  }
}

async function tagSetzen(montag, index, gerichtId) {
  const schluessel = datumSchluessel(montag);
  const alt = plaene.get(schluessel);
  const plan = {
    woche: schluessel,
    tage: alt ? alt.tage.slice() : [null, null, null, null, null],
    sport: sportTage(alt),
    aktualisiert: zeitNach(alt),
    dirty: 1
  };
  plan.tage[index] = gerichtId;
  try {
    await schreiben("wochenplan", function (s) { return s.put(plan); });
    await plaeneNeuLaden();
    blattSchliessen();
    syncAnstossen();
  } catch (fehler) {
    alert("Das Speichern hat leider nicht geklappt.");
  }
}

/* ---------- Symbole für Artikel (Emoji; sonst der Anfangsbuchstabe) ---------- */

const ARTIKEL_SYMBOLE = [
  ["🍎", "apfel äpfel"], ["🍐", "birne"], ["🍌", "banane"], ["🍊", "orange mandarine clementine"], ["🍋", "zitrone limette"],
  ["🍓", "erdbeere"], ["🍇", "traube"], ["🍉", "melone"], ["🍒", "kirsche"], ["🍑", "pfirsich nektarine"], ["🍍", "ananas"],
  ["🥭", "mango"], ["🥝", "kiwi"], ["🍅", "tomate"], ["🥒", "gurke"], ["🫑", "paprika"], ["🥕", "möhre karotte"],
  ["🌽", "mais"], ["🥔", "kartoffel"], ["🧅", "zwiebel"], ["🧄", "knoblauch"], ["🍄", "pilz champignon"],
  ["🥬", "salat spinat kohl lauch mangold"], ["🥦", "brokkoli blumenkohl"], ["🍆", "aubergine"], ["🥑", "avocado"],
  ["🎃", "kürbis"], ["🥜", "nuss nüsse erdnuss mandel"], ["🥥", "kokos kokosnuss kokosmilch"], ["🫒", "olive olivenöl"], ["🌶️", "chili pfeffer"],
  ["🍞", "brot toast"], ["🥖", "brötchen baguette semmel"], ["🥐", "croissant"], ["🥨", "brezel"],
  ["🍝", "nudel spaghetti pasta penne fusilli"], ["🍚", "reis"], ["🌾", "mehl haferflocken"], ["🍕", "pizza"],
  ["🍔", "burger"], ["🍟", "pommes"], ["🌭", "wurst würstchen bratwurst"], ["🍰", "kuchen torte"], ["🍪", "keks kekse"],
  ["🍫", "schokolade"], ["🍬", "bonbon gummibärchen süßigkeit"], ["🍯", "honig marmelade"], ["🥣", "müsli cornflakes"],
  ["🍲", "suppe eintopf"], ["🥛", "milch joghurt sahne quark"], ["🧈", "butter margarine"], ["🧀", "käse"],
  ["🥚", "ei eier"], ["🥩", "fleisch steak hack hackfleisch"], ["🍗", "hähnchen hühnchen huhn pute"], ["🥓", "speck schinken"],
  ["🐟", "lachs fisch thunfisch forelle"], ["🦐", "garnele shrimp"], ["💧", "wasser sprudel"], ["🧃", "saft"],
  ["☕", "kaffee espresso"], ["🍵", "tee"], ["🍺", "bier"], ["🍷", "wein"], ["🥂", "sekt prosecco"], ["🥤", "cola limo limonade"],
  ["🧂", "salz"], ["🍦", "eis eiscreme"], ["🧻", "toilettenpapier klopapier küchenrolle"], ["🪥", "zahnpasta zahnbürste"],
  ["🧼", "seife"], ["🧴", "shampoo spülmittel duschgel creme"], ["🧺", "waschmittel"], ["🗑️", "müllbeutel müllsack"],
  ["🔋", "batterie batterien"], ["💡", "glühbirne"], ["🕯️", "kerze kerzen"], ["💐", "blume blumen"], ["🐾", "tierfutter katzenfutter hundefutter"]
];
const ARTIKEL_SYMBOL_INDEX = (function () {
  const liste = [];
  ARTIKEL_SYMBOLE.forEach(function (eintrag) {
    eintrag[1].split(" ").forEach(function (wort) { liste.push([wort, eintrag[0]]); });
  });
  return liste;
})();

// Findet ein Emoji zum Artikelnamen. Deutsche Zusammensetzungen werden erkannt (Vollkornbrot -> Brot).
function artikelSymbol(name) {
  const woerter = String(name || "").toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);
  let bestes = null, bestePunkte = 0;
  woerter.forEach(function (w) {
    ARTIKEL_SYMBOL_INDEX.forEach(function (k) {
      const schluessel = k[0];
      let punkte = 0;
      if (w === schluessel) punkte = 100 + schluessel.length;
      else if (schluessel.length >= 4 && w.endsWith(schluessel)) punkte = 50 + schluessel.length;
      else if (schluessel.length >= 4 && w.startsWith(schluessel)) punkte = 20 + schluessel.length;
      if (punkte > bestePunkte) { bestePunkte = punkte; bestes = k[1]; }
    });
  });
  return bestes;
}

function symbolKnoten(name) {
  const emoji = artikelSymbol(name);
  if (emoji) return el("span", { class: "symbol", "aria-hidden": "true", text: emoji });
  const buchstabe = String(name || "").trim().charAt(0).toUpperCase() || "?";
  return el("span", { class: "symbol buchstabe", "aria-hidden": "true", text: buchstabe });
}

// Langes Drücken (ca. 0,6 s) löst eine Aktion aus; der anschließende Tipp wird dann nicht als Antippen gewertet.
function langDruck(knopf, aktion) {
  let timer = null, startX = 0, startY = 0, ausgeloest = false;
  function abbrechen() { if (timer) { clearTimeout(timer); timer = null; } }
  knopf.addEventListener("pointerdown", function (e) {
    ausgeloest = false; startX = e.clientX; startY = e.clientY;
    abbrechen();
    timer = setTimeout(function () { timer = null; ausgeloest = true; aktion(); }, 600);
  });
  knopf.addEventListener("pointermove", function (e) {
    if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) abbrechen();
  });
  knopf.addEventListener("pointerup", abbrechen);
  knopf.addEventListener("pointercancel", abbrechen);
  knopf.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  knopf.addEventListener("click", function (e) {
    if (ausgeloest) { ausgeloest = false; e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

/* ---------- Einkaufsliste ---------- */

// kg und l werden intern in g und ml gerechnet, damit z. B. 600 g + 700 g = 1,3 kg ergibt.
const EINHEITEN_UMRECHNUNG = { g: ["g", 1], kg: ["g", 1000], ml: ["ml", 1], l: ["ml", 1000] };

// Zählt die Zutaten aller für die Woche geplanten Gerichte zusammen.
// Ein Gericht, das an mehreren Tagen geplant ist, zählt entsprechend mehrfach.
function einkaufslisteBerechnen(montag) {
  const plan = plaene.get(datumSchluessel(montag));
  const posten = new Map();
  let anzahlGerichte = 0;

  (plan ? plan.tage : []).forEach(function (id) {
    const g = id === null || id === undefined ? null : gerichte.find(function (x) { return x.id === id; });
    if (!g) return;
    anzahlGerichte++;
    g.zutaten.forEach(function (z) {
      const name = z.name.trim();
      const hatMenge = z.menge !== null && z.menge !== undefined;
      const umrechnung = EINHEITEN_UMRECHNUNG[z.einheit];
      const gruppe = hatMenge ? (umrechnung ? umrechnung[0] : z.einheit) : "";
      const schluessel = name.toLowerCase() + "|" + gruppe;
      if (!posten.has(schluessel)) posten.set(schluessel, { schluessel: schluessel, name: name, gruppe: gruppe, summe: 0 });
      if (hatMenge) posten.get(schluessel).summe += z.menge * (umrechnung ? umrechnung[1] : 1);
    });
  });

  // Eine Zutat ohne Menge (z. B. "Salz") entfällt, wenn dieselbe Zutat anderswo mit Menge vorkommt.
  const mitMenge = new Set();
  posten.forEach(function (p) { if (p.gruppe) mitMenge.add(p.name.toLowerCase()); });

  const liste = Array.from(posten.values()).filter(function (p) {
    return p.gruppe || !mitMenge.has(p.name.toLowerCase());
  }).sort(function (a, b) {
    return a.name.localeCompare(b.name, "de") || a.gruppe.localeCompare(b.gruppe, "de");
  });
  return { posten: liste, anzahlGerichte: anzahlGerichte };
}

function mengeText(p) {
  if (!p.gruppe) return "";
  if (p.gruppe === "g") return p.summe >= 1000 ? zahlText(p.summe / 1000) + " kg" : zahlText(p.summe) + " g";
  if (p.gruppe === "ml") return p.summe >= 1000 ? zahlText(p.summe / 1000) + " l" : zahlText(p.summe) + " ml";
  return zahlText(p.summe) + " " + p.gruppe;
}

// Die eigenen Artikel einer Woche (ohne gelöschte), nach Name sortiert.
function extrasFuer(woche) {
  return Array.from(extras.values()).filter(function (e) { return e.woche === woche && !e.geloescht; })
    .sort(function (a, b) { return a.name.localeCompare(b.name, "de"); });
}

function einkaufZeichnen() {
  const box = document.getElementById("einkauf");
  const montag = angezeigteWoche;
  const woche = datumSchluessel(montag);
  const ergebnis = einkaufslisteBerechnen(montag);
  const abgehakt = abgehakteFuer(woche);
  const eigene = extrasFuer(woche);

  // Zutaten aus dem Wochenplan und eigene Artikel stehen in einer gemeinsamen Liste.
  const alle = ergebnis.posten.map(function (p) {
    return { name: p.name, quelle: "rezept", p: p, erledigt: abgehakt.has(p.schluessel) };
  }).concat(eigene.map(function (e) {
    return { name: e.name, quelle: "eigen", e: e, erledigt: !!e.erledigt };
  })).sort(function (x, y) {
    return x.name.localeCompare(y.name, "de") || (x.quelle < y.quelle ? -1 : x.quelle > y.quelle ? 1 : 0);
  });
  const offen = alle.filter(function (x) { return !x.erledigt; });
  const erledigt = alle.filter(function (x) { return x.erledigt; });

  const hatteFokus = document.activeElement && document.activeElement.id === "extra-name";
  const teile = wochenKopf();
  teile.push(extraEingabe(woche));

  function zeile(x) {
    return x.quelle === "rezept" ? postenZeile(x.p, x.erledigt, montag) : extraZeile(x.e);
  }

  if (ergebnis.anzahlGerichte === 0 && eigene.length === 0) {
    teile.push(el("div", { class: "karte leer" },
      el("div", { class: "leer-symbol", text: "🛒" }),
      el("h2", { text: "Noch nichts zu kaufen" }),
      el("p", { text: "Für diese Woche ist noch kein Gericht geplant. Wähle sie im Reiter „Wochenplan“ aus oder füge oben einen eigenen Artikel hinzu." })
    ));
  } else if (alle.length === 0) {
    teile.push(el("div", { class: "karte" },
      el("p", { text: "Die geplanten Gerichte haben keine Zutaten eingetragen." })
    ));
  } else {
    const quellen = [];
    if (ergebnis.anzahlGerichte > 0) {
      quellen.push("Aus " + ergebnis.anzahlGerichte + (ergebnis.anzahlGerichte === 1 ? " geplantem Gericht" : " geplanten Gerichten"));
    }
    if (eigene.length > 0) quellen.push(eigene.length + (eigene.length === 1 ? " eigener Artikel" : " eigene Artikel"));
    teile.push(el("p", {
      class: "leise einkauf-info",
      text: quellen.join(" + ") + " · " + erledigt.length + " von " + alle.length + " erledigt"
    }));

    const knoepfe = [];
    if (offen.length > 0) {
      knoepfe.push(el("button", {
        class: "knopf knopf-sekundaer", type: "button", text: "Liste teilen",
        onclick: function () {
          einkaufTeilen(montag,
            offen.filter(function (x) { return x.quelle === "rezept"; }).map(function (x) { return x.p; }),
            offen.filter(function (x) { return x.quelle === "eigen"; }).map(function (x) { return x.e; }));
        }
      }));
    }
    if (erledigt.length > 0) {
      knoepfe.push(el("button", { class: "knopf knopf-sekundaer", type: "button", onclick: function () { hakenZuruecksetzen(montag); }, text: "Haken entfernen" }));
    }
    if (knoepfe.length > 0) teile.push(el("div", { class: "reihe" }, knoepfe));

    if (offen.length > 0) {
      teile.push(el("div", { class: "posten-liste" }, offen.map(zeile)));
    } else {
      teile.push(el("p", { class: "leise", text: "Alles erledigt." }));
    }
    if (erledigt.length > 0) {
      teile.push(el("h3", { class: "abschnitt", text: "Erledigt" }));
      teile.push(el("div", { class: "posten-liste" }, erledigt.map(zeile)));
    }
  }
  if (eigene.length > 0) {
    teile.push(el("p", { class: "leise hinweis-klein", text: "Eigene Artikel: gedrückt halten zum Entfernen." }));
  }
  zuletztVerwendet(woche).forEach(function (n) { teile.push(n); });
  box.replaceChildren.apply(box, teile);
  if (hatteFokus) {
    const feld = document.getElementById("extra-name");
    if (feld) { feld.focus(); try { feld.setSelectionRange(feld.value.length, feld.value.length); } catch (x) { /* egal */ } }
  }
}

// "2", "2 x", "2 Tuben", "1,5 l" -> { zahl, einheit }; Text ohne führende Zahl -> null
function extraMengeLesen(text) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:[x×](?=\s|$))?\s*(.*?)\s*$/i.exec(text || "");
  return m ? { zahl: Number(m[1].replace(",", ".")), einheit: m[2] } : null;
}

// Zählt zwei Mengenangaben zusammen, wenn sie dieselbe Einheit haben (1 + 2 = 3, 1 Dose + 2 Dose = 3 Dose).
// Passen sie nicht zusammen, werden beide untereinander aufgeführt ("1 Packung + 500 g").
function extraMengenSummieren(alt, neu) {
  if (!neu.trim()) return alt;
  if (!alt.trim()) return neu;
  const a = extraMengeLesen(alt), n = extraMengeLesen(neu);
  if (a && n && a.einheit.toLowerCase() === n.einheit.toLowerCase()) {
    return zahlText(a.zahl + n.zahl) + (a.einheit ? " " + a.einheit : "");
  }
  return alt + " + " + neu;
}

// Eingabezeile für eigene Artikel (Name, optionale Menge) mit Vorschlägen aus früheren Einträgen.
function extraEingabe(woche) {
  const name = el("input", {
    type: "text", id: "extra-name", class: "eingabe", list: "extravorschlaege", autocomplete: "off",
    autocapitalize: "sentences", placeholder: "Artikel hinzufügen", "aria-label": "Artikel", value: extraEntwurf.name
  });
  const menge = el("input", {
    type: "text", id: "extra-menge", class: "eingabe extra-menge", autocomplete: "off",
    placeholder: "Menge", "aria-label": "Menge (optional)", value: extraEntwurf.menge
  });
  name.addEventListener("input", function () { extraEntwurf.name = name.value; });
  menge.addEventListener("input", function () { extraEntwurf.menge = menge.value; });
  return el("form", {
    class: "extra-form",
    onsubmit: function (e) { e.preventDefault(); extraHinzufuegen(woche, name.value, menge.value); }
  },
    name, menge,
    el("button", { class: "knopf knopf-primaer extra-plus", type: "submit", "aria-label": "Zur Liste hinzufügen", text: "+" })
  );
}

function extraZeile(e) {
  const kachel = el("button", {
    class: "posten eigen" + (e.erledigt ? " erledigt" : ""), type: "button", role: "checkbox",
    "aria-checked": e.erledigt ? "true" : "false",
    onclick: function () { extraUmschalten(e.id); }
  },
    el("span", { class: "haken", text: e.erledigt ? "✓" : "" }),
    symbolKnoten(e.name),
    el("span", { class: "posten-name", text: e.name }),
    el("span", { class: "posten-menge", text: e.menge || "" })
  );
  // Eigene Artikel entfernt man durch langes Drücken.
  langDruck(kachel, function () {
    if (confirm("„" + e.name + "“ von der Liste entfernen?")) extraLoeschen(e.id);
  });
  return kachel;
}

// "Zuletzt verwendet": frühere eigene Artikel, die gerade nicht auf der Liste stehen. Ein Tipp setzt sie wieder drauf.
function zuletztVerwendet(woche) {
  const aktiv = new Set(extrasFuer(woche).map(function (e) { return e.name.toLowerCase(); }));
  const kandidaten = Array.from(extraVorschlaege().values()).filter(function (e) { return !aktiv.has(e.name.toLowerCase()); })
    .sort(function (a, b) { return b.aktualisiert - a.aktualisiert; }).slice(0, 12)
    .sort(function (a, b) { return a.name.localeCompare(b.name, "de"); });
  if (kandidaten.length === 0) return [];
  return [
    el("h3", { class: "abschnitt", text: "Zuletzt verwendet" }),
    el("div", { class: "vorschlag-liste" }, kandidaten.map(function (e) {
      return el("button", {
        class: "vorschlag-kachel", type: "button", "aria-label": e.name + " wieder hinzufügen",
        onclick: function () { extraHinzufuegen(woche, e.name, e.menge || ""); }
      },
        symbolKnoten(e.name),
        el("span", { class: "posten-name", text: e.name }),
        el("span", { class: "posten-menge", text: e.menge || "" })
      );
    }))
  ];
}

async function extraSpeichern(eintraege) {
  eintraege.forEach(function (e) { extras.set(e.id, e); });
  einkaufZeichnen(); // sofort anzeigen, dann speichern
  extraVorschlaegeAktualisieren();
  try {
    await transaktion(["extras"], function (st) { eintraege.forEach(function (e) { st.extras.put(e); }); });
    await extrasNeuLaden();
    syncAnstossen();
  } catch (fehler) {
    alert("Das Speichern hat leider nicht geklappt.");
  }
}

async function extraHinzufuegen(woche, nameText, mengeText2) {
  const name = nameText.trim();
  if (name === "") return;
  const menge = mengeText2.trim();
  extraEntwurf = { name: "", menge: "" };
  // Gibt es den Artikel in dieser Woche schon, wird nichts doppelt angelegt.
  const vorhanden = Array.from(extras.values()).find(function (e) {
    return e.woche === woche && !e.geloescht && e.name.toLowerCase() === name.toLowerCase();
  });
  if (vorhanden) {
    // Noch offen: Mengen zusammenzählen. Schon abgehakt (also gekauft): neu auf die Liste, mit der neuen Menge.
    const neueMenge = vorhanden.erledigt ? (menge || vorhanden.menge) : extraMengenSummieren(vorhanden.menge || "", menge);
    await extraSpeichern([Object.assign({}, vorhanden, {
      erledigt: false, menge: neueMenge, aktualisiert: zeitNach(vorhanden), dirty: 1
    })]);
    return;
  }
  await extraSpeichern([{
    id: neueId(), woche: woche, name: name, menge: menge, erledigt: false, geloescht: false,
    aktualisiert: Date.now(), dirty: 1
  }]);
}

async function extraUmschalten(id) {
  const e = extras.get(id);
  if (!e) return;
  await extraSpeichern([Object.assign({}, e, { erledigt: !e.erledigt, aktualisiert: zeitNach(e), dirty: 1 })]);
}

async function extraLoeschen(id) {
  const e = extras.get(id);
  if (!e) return;
  // Nur als gelöscht markiert: so verschwindet er auch auf dem anderen Gerät, und der Name bleibt als Vorschlag.
  await extraSpeichern([Object.assign({}, e, { geloescht: true, erledigt: false, aktualisiert: zeitNach(e), dirty: 1 })]);
}

function postenZeile(p, erledigt, montag) {
  return el("button", {
    class: "posten" + (erledigt ? " erledigt" : ""), type: "button", role: "checkbox",
    "aria-checked": erledigt ? "true" : "false",
    onclick: function () { postenUmschalten(montag, p.schluessel); }
  },
    el("span", { class: "haken", text: erledigt ? "✓" : "" }),
    symbolKnoten(p.name),
    el("span", { class: "posten-name", text: p.name }),
    el("span", { class: "posten-menge", text: mengeText(p) })
  );
}

// Jeder Haken ist ein eigener Eintrag mit eigenem Zeitstempel. So können du und deine Frau
// gleichzeitig im Supermarkt abhaken, ohne dass sich eure Haken überschreiben.
async function hakenSpeichern(eintraege) {
  eintraege.forEach(function (e) { haken.set(e.id, e); });
  einkaufZeichnen(); // sofort anzeigen, dann speichern
  try {
    await transaktion(["haken"], function (s) { eintraege.forEach(function (e) { s.haken.put(e); }); });
    await hakenNeuLaden();
    syncAnstossen();
  } catch (fehler) {
    alert("Das Speichern hat leider nicht geklappt.");
  }
}

async function postenUmschalten(montag, schluessel) {
  const woche = datumSchluessel(montag);
  const id = woche + "|" + schluessel;
  const alt = haken.get(id);
  await hakenSpeichern([{
    id: id, woche: woche, posten: schluessel, erledigt: !(alt && alt.erledigt), aktualisiert: zeitNach(alt), dirty: 1
  }]);
}

async function hakenZuruecksetzen(montag) {
  const woche = datumSchluessel(montag);
  const neue = [];
  haken.forEach(function (h) {
    if (h.woche === woche && h.erledigt) {
      neue.push({ id: h.id, woche: h.woche, posten: h.posten, erledigt: false, aktualisiert: zeitNach(h), dirty: 1 });
    }
  });
  const neueExtras = [];
  extras.forEach(function (e) {
    if (e.woche === woche && e.erledigt && !e.geloescht) {
      neueExtras.push(Object.assign({}, e, { erledigt: false, aktualisiert: zeitNach(e), dirty: 1 }));
    }
  });
  if (neue.length > 0) await hakenSpeichern(neue);
  if (neueExtras.length > 0) await extraSpeichern(neueExtras);
}

// Öffnet das iPhone-Teilen-Menü (Nachrichten, WhatsApp, Notizen …) mit den offenen Posten.
async function einkaufTeilen(montag, offene, eigeneOffen) {
  const freitag = tagVerschieben(montag, 4);
  const zeilen = offene.map(function (p) {
    const menge = mengeText(p);
    return "• " + (menge ? menge + " " : "") + p.name;
  });
  (eigeneOffen || []).forEach(function (e) { zeilen.push("• " + (e.menge ? e.menge + " " : "") + e.name); });
  const text = "Einkaufsliste KW " + kalenderwoche(montag) + " (" + kurzDatum(montag) + " – " +
    kurzDatum(freitag) + freitag.getFullYear() + ")\n" + zeilen.join("\n");
  try {
    if (navigator.share) {
      await navigator.share({ title: "Einkaufsliste", text: text });
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      alert("Die Liste wurde kopiert.");
    } else {
      alert("Teilen wird auf diesem Gerät nicht unterstützt.");
    }
  } catch (fehler) {
    if (!fehler || fehler.name !== "AbortError") alert("Das Teilen hat leider nicht geklappt.");
  }
}

/* ---------- Wochenplan als Bild teilen ---------- */

const TEILEN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

function teilenIconKnoten() {
  const e = el("span", { class: "teilen-icon" });
  e.innerHTML = TEILEN_ICON;
  return e;
}

function kreisFarbe(titel) {
  let h = 0;
  for (let i = 0; i < titel.length; i++) h = (h * 31 + titel.charCodeAt(i)) >>> 0;
  return KREIS_FARBEN[h % KREIS_FARBEN.length];
}

function bildLaden(src) {
  return new Promise(function (ok) {
    const b = new Image();
    b.onload = function () { ok(b); };
    b.onerror = function () { ok(null); };
    b.src = src;
  });
}

function rundRechteck(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function textKuerzen(c, text, breite, maxZeilen) {
  const woerter = text.split(" ");
  const zeilen = [];
  let zeile = "";
  for (let i = 0; i < woerter.length; i++) {
    const probe = zeile ? zeile + " " + woerter[i] : woerter[i];
    if (c.measureText(probe).width <= breite || !zeile) { zeile = probe; }
    else { zeilen.push(zeile); zeile = woerter[i]; }
  }
  zeilen.push(zeile);
  if (zeilen.length > maxZeilen) {
    const rest = zeilen.slice(maxZeilen - 1).join(" ");
    zeilen.length = maxZeilen - 1;
    let k = rest;
    while (k.length > 1 && c.measureText(k + "…").width > breite) k = k.slice(0, -1);
    zeilen.push(k + "…");
  }
  return zeilen;
}

function sportIconZeichnen(c, mx, my, groesse, farbe) {
  c.save();
  c.translate(mx - groesse / 2, my - groesse / 2);
  c.scale(groesse / 24, groesse / 24);
  c.strokeStyle = farbe;
  c.lineWidth = 2.4;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.stroke(new Path2D("M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"));
  c.restore();
}

// Malt den Wochenplan im aktuell gewählten Farbstil und liefert ein PNG.
async function planBildErzeugen(montag) {
  const plan = plaene.get(datumSchluessel(montag));
  const sport = sportTage(plan);
  const stil = getComputedStyle(document.documentElement);
  const farbe = function (name, ersatz) { return stil.getPropertyValue(name).trim() || ersatz; };
  const BG = farbe("--bg", "#2a313c"), KARTE = farbe("--karte", "#323a47"), AKZENT = farbe("--akzent", "#f5b73c");
  const TEXT = farbe("--text", "#eef1f5"), LEISE = farbe("--text-leise", "#9aa5b5");
  const SPORT = farbe("--sport", "#4f9fe3"), AUF_SPORT = farbe("--auf-sport", "#ffffff");
  const SCHRIFT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const eintraege = [];
  for (let i = 0; i < 5; i++) {
    const id = plan ? plan.tage[i] : null;
    const g = id === null || id === undefined ? null : gerichte.find(function (x) { return x.id === id; });
    eintraege.push({ g: g || null, aus: id === AUSWAERTS, foto: g && g.bild ? await bildLaden(g.bild) : null });
  }
  const hatSport = sport.some(function (x) { return x; });

  const B = 1080, RAND = 60, KH = 196, LUECKE = 24;
  const H = 68 + 130 + 5 * KH + 4 * LUECKE + (hatSport ? 110 : 60);
  const cv = document.createElement("canvas");
  cv.width = B; cv.height = H;
  const c = cv.getContext("2d");
  c.fillStyle = BG; c.fillRect(0, 0, B, H);
  c.textBaseline = "alphabetic";

  // Kopf: Logo links, Kalenderwoche rechts
  const freitag = tagVerschieben(montag, 4);
  c.fillStyle = AKZENT;
  c.save(); c.translate(RAND, 96); c.scale(2.2, 2.2);
  c.fill(new Path2D("M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5 2.5 2.5 0 0 1 12 11.5z"));
  c.restore();
  c.font = "800 52px " + SCHRIFT;
  c.fillStyle = TEXT; c.textAlign = "left";
  c.fillText("Meal", RAND + 64, 134);
  const wMeal = c.measureText("Meal").width;
  c.fillStyle = AKZENT;
  c.fillText("Map", RAND + 64 + wMeal, 134);
  c.textAlign = "right";
  c.fillStyle = TEXT; c.font = "800 60px " + SCHRIFT;
  c.fillText("KW " + kalenderwoche(montag), B - RAND, 120);
  c.fillStyle = LEISE; c.font = "400 30px " + SCHRIFT;
  c.fillText(kurzDatum(montag) + " – " + kurzDatum(freitag) + freitag.getFullYear(), B - RAND, 164);

  // Tageskarten
  let y = 68 + 130;
  for (let i = 0; i < 5; i++) {
    const e = eintraege[i], g = e.g, belegt = !!g || e.aus;
    const x = RAND, w = B - 2 * RAND, FOTO = 156, ix = x + 20, iy = y + (KH - FOTO) / 2;
    if (belegt) {
      c.fillStyle = KARTE; rundRechteck(c, x, y, w, KH, 40); c.fill();
    } else {
      c.save(); c.setLineDash([14, 12]); c.lineWidth = 3; c.strokeStyle = LEISE; c.globalAlpha = 0.55;
      rundRechteck(c, x + 1.5, y + 1.5, w - 3, KH - 3, 40); c.stroke(); c.restore();
    }
    // Foto oder Ring
    c.save();
    rundRechteck(c, ix, iy, FOTO, FOTO, 32); c.clip();
    if (g && e.foto) {
      const f = Math.max(FOTO / e.foto.width, FOTO / e.foto.height);
      c.drawImage(e.foto, ix + (FOTO - e.foto.width * f) / 2, iy + (FOTO - e.foto.height * f) / 2, e.foto.width * f, e.foto.height * f);
    } else if (e.aus) {
      c.globalAlpha = 0.18; c.fillStyle = AKZENT; c.fillRect(ix, iy, FOTO, FOTO); c.globalAlpha = 1;
      c.save(); c.translate(ix + FOTO / 2 - 40, iy + FOTO / 2 - 40); c.scale(80 / 24, 80 / 24);
      c.strokeStyle = AKZENT; c.lineWidth = 2; c.lineCap = "round"; c.lineJoin = "round";
      c.stroke(new Path2D(AUSWAERTS_PFAD)); c.restore();
    } else if (g) {
      const f = kreisFarbe(g.titel);
      c.fillStyle = f[0]; c.fillRect(ix, iy, FOTO, FOTO);
      c.strokeStyle = f[1]; c.lineWidth = 34; c.beginPath(); c.arc(ix + FOTO / 2, iy + FOTO / 2, 62, 0, Math.PI * 2); c.stroke();
    } else {
      c.globalAlpha = 0.4; c.strokeStyle = AKZENT; c.lineWidth = 14;
      c.beginPath(); c.arc(ix + FOTO / 2, iy + FOTO / 2, 66, 0, Math.PI * 2); c.stroke();
    }
    c.restore();
    if (!belegt) {
      c.fillStyle = LEISE; c.globalAlpha = 0.6; c.textAlign = "center"; c.font = "800 52px " + SCHRIFT;
      c.fillText("?", ix + FOTO / 2, iy + FOTO / 2 + 18); c.globalAlpha = 1;
    }
    // Texte
    const tx = ix + FOTO + 32, tb = x + w - 40 - tx - (belegt && sport[i] ? 104 : 0);
    c.textAlign = "left";
    c.font = "700 41px " + SCHRIFT;
    const zweiZeilig = g ? textKuerzen(c, g.titel, tb, 2).length === 2 : false;
    c.font = "700 27px " + SCHRIFT;
    if ("letterSpacing" in c) c.letterSpacing = "3px";
    c.fillStyle = belegt ? AKZENT : LEISE;
    c.fillText(TAGNAMEN[i].toUpperCase(), tx, y + (zweiZeilig ? 52 : 58));
    if ("letterSpacing" in c) c.letterSpacing = "0px";
    c.fillStyle = belegt ? TEXT : LEISE;
    if (e.aus) {
      c.font = "700 41px " + SCHRIFT;
      c.fillText("Auswärts essen", tx, y + 112);
      c.font = "400 27px " + SCHRIFT; c.fillStyle = LEISE;
      c.fillText("Kein Gericht geplant", tx, y + 160);
    } else if (g) {
      c.font = "700 41px " + SCHRIFT;
      let zeilen = textKuerzen(c, g.titel, tb, 2);
      if (zeilen.length === 2) { c.font = "700 36px " + SCHRIFT; zeilen = textKuerzen(c, g.titel, tb, 2); }
      const meta = [zahlText(g.portionen) + " " + pluralPortionen(g.portionen)];
      if (KH_TEXT[g.khStufe]) meta.push(KH_TEXT[g.khStufe]);
      if (ERN_TEXT[g.ernaehrung]) meta.push(ERN_TEXT[g.ernaehrung]);
      const zwei = zeilen.length === 2;
      zeilen.forEach(function (z, k) { c.fillText(z, tx, y + (zwei ? 98 : 112) + k * 42); });
      c.font = "400 27px " + SCHRIFT; c.fillStyle = LEISE;
      c.fillText(textKuerzen(c, meta.join(" · "), tb, 1)[0], tx, y + (zwei ? 174 : 160));
    } else {
      c.font = "500 36px " + SCHRIFT;
      c.fillText("Noch offen", tx, y + 114);
    }
    // Sport-Badge
    if (belegt && sport[i]) {
      const bx = x + w - 40 - 38, by = y + KH / 2;
      c.fillStyle = SPORT; c.beginPath(); c.arc(bx, by, 38, 0, Math.PI * 2); c.fill();
      sportIconZeichnen(c, bx, by, 40, AUF_SPORT);
    }
    y += KH + LUECKE;
  }

  // Legende
  if (hatSport) {
    const my = y + 24;
    c.font = "400 28px " + SCHRIFT;
    const tw = c.measureText("Sporttag").width, gesamt = 44 + 14 + tw, sx = (B - gesamt) / 2;
    c.fillStyle = SPORT; c.beginPath(); c.arc(sx + 22, my, 22, 0, Math.PI * 2); c.fill();
    sportIconZeichnen(c, sx + 22, my, 24, AUF_SPORT);
    c.fillStyle = LEISE; c.textAlign = "left"; c.fillText("Sporttag", sx + 44 + 14, my + 10);
  }
  return new Promise(function (ok) { cv.toBlob(ok, "image/png"); });
}

function planTeilenText(montag) {
  const diff = Math.round((montag - standardWoche()) / (7 * 24 * 3600 * 1000));
  if (diff === 1) return "Das essen wir nächste Woche 🍽️";
  if (diff === 0) return "Das essen wir diese Woche 🍽️";
  return "Das essen wir in KW " + kalenderwoche(montag) + " 🍽️";
}

async function planTeilenOeffnen() {
  const montag = angezeigteWoche;
  const vorschau = el("img", { class: "plan-vorschau", alt: "Wochenplan als Bild" });
  const nachricht = el("textarea", { class: "plan-text", rows: "2" });
  nachricht.value = planTeilenText(montag);
  let blob = null;
  let url = null;
  function zu() { if (url) URL.revokeObjectURL(url); blattSchliessen(); }
  async function teilen() {
    if (!blob) return;
    const datei = new File([blob], "MealMap-KW" + kalenderwoche(montag) + ".png", { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [datei] })) {
        await navigator.share({ files: [datei], text: nachricht.value });
      } else if (navigator.share) {
        await navigator.share({ title: "MealMap", text: nachricht.value });
      } else {
        alert("Teilen wird auf diesem Gerät nicht unterstützt.");
      }
    } catch (fehler) {
      if (!fehler || fehler.name !== "AbortError") alert("Das Teilen hat leider nicht geklappt.");
    }
  }
  blattZeigen({
    titel: "Plan teilen",
    links: { text: "Schließen", aktion: zu },
    rechts: { text: "Teilen", aktion: teilen },
    inhalt: [
      el("div", { class: "plan-vorschau-huelle" }, vorschau),
      el("label", { class: "plan-label", text: "Nachricht dazu" }),
      nachricht
    ]
  });
  blob = await planBildErzeugen(montag);
  url = URL.createObjectURL(blob);
  vorschau.src = url;
}

/* ---------- Zutaten-Vorschläge ---------- */

// Alle bisher verwendeten Zutaten, damit beim Tippen z. B. "Mi" -> "Milch" vorgeschlagen wird.
function vorschlaegeAktualisieren() {
  const liste = document.getElementById("zutatenvorschlaege");
  const gesehen = new Map();
  gerichte.forEach(function (g) {
    g.zutaten.forEach(function (z) {
      const schluessel = z.name.toLowerCase();
      if (!gesehen.has(schluessel)) gesehen.set(schluessel, z.name);
    });
  });
  const namen = Array.from(gesehen.values()).sort(function (a, b) { return a.localeCompare(b, "de"); });
  liste.replaceChildren.apply(liste, namen.map(function (name) { return el("option", { value: name }); }));
}

// Frühere eigene Artikel (auch gelöschte) als Vorschläge: kleingeschriebener Name -> jüngster Eintrag.
function extraVorschlaege() {
  const karte = new Map();
  extras.forEach(function (e) {
    const k = e.name.toLowerCase();
    const alt = karte.get(k);
    if (!alt || e.aktualisiert > alt.aktualisiert) karte.set(k, e);
  });
  return karte;
}

function extraVorschlaegeAktualisieren() {
  const liste = document.getElementById("extravorschlaege");
  if (!liste) return;
  const namen = Array.from(extraVorschlaege().values()).map(function (e) { return e.name; })
    .sort(function (a, b) { return a.localeCompare(b, "de"); });
  liste.replaceChildren.apply(liste, namen.map(function (n) { return el("option", { value: n }); }));
}

/* ---------- Laden aus der Datenbank ---------- */

// Liest einen Speicher neu ein und zeichnet die Ansichten neu. Starten kurz hintereinander
// mehrere Ladevorgänge, zählt nur der neueste (ein älterer Stand überschreibt nie einen neueren).
function ladefunktion(speicherName, uebernehmen) {
  let zaehler = 0;
  return async function () {
    const meine = ++zaehler;
    const daten = await alleLesen(speicherName);
    if (meine !== zaehler) return;
    uebernehmen(daten);
  };
}

const gerichteNeuLaden = ladefunktion("gerichte", function (liste) {
  gerichteRoh = new Map(liste.map(function (g) { return [g.id, g]; }));
  gerichteAbleiten();
  listeZeichnen();
  wochenAnsichtenZeichnen();
  vorschlaegeAktualisieren();
});

const plaeneNeuLaden = ladefunktion("wochenplan", function (liste) {
  plaene = new Map(liste.map(function (p) { return [p.woche, p]; }));
  wochenAnsichtenZeichnen();
});

const hakenNeuLaden = ladefunktion("haken", function (liste) {
  haken = new Map(liste.map(function (h) { return [h.id, h]; }));
  einkaufZeichnen();
});

const extrasNeuLaden = ladefunktion("extras", function (liste) {
  extras = new Map(liste.map(function (e) { return [e.id, e]; }));
  extraVorschlaegeAktualisieren();
  einkaufZeichnen();
});

async function alleNeuLaden() {
  await gerichteNeuLaden();
  await plaeneNeuLaden();
  await hakenNeuLaden();
  await extrasNeuLaden();
}

/* ---------- Synchronisierung mit Supabase ---------- */

// Prinzip: Die App arbeitet immer zuerst mit den Daten auf dem Gerät. Im Hintergrund werden
// geänderte Einträge hochgeladen (push) und neue Einträge der anderen Geräte geholt (pull).
// Bei einem Konflikt gewinnt die jüngere Änderung (Zeitstempel "aktualisiert").
// Einträge mit "dirty: 1" sind lokal geändert und noch nicht hochgeladen.

const KONFIG = window.ESSENSPLAN_CONFIG || {};
let sb = null;            // Supabase-Client (nur wenn config.js ausgefüllt ist)
let sbSitzung = null;     // aktuelle Anmeldung
let syncStatus = "aus";   // aus | abgemeldet | laeuft | ok | offline | fehler
let syncMeldung = "";
let letzteSync = null;
let syncLaeuft = false;
let syncNochmal = false;
let syncTimer = null;

// Beschreibt für jede Tabelle, wie ein lokaler Eintrag in eine Zeile auf dem Server übersetzt wird und zurück.
const SYNC_TABELLEN = [
  {
    name: "gerichte", speicher: "gerichte", konflikt: "id", block: 3,
    liste: function () { return Array.from(gerichteRoh.values()); },
    holen: function (schluessel) { return gerichteRoh.get(schluessel); },
    neuLaden: function () { return gerichteNeuLaden(); },
    schluesselLokal: function (r) { return r.id; },
    schluesselServer: function (z) { return z.id; },
    zuServer: function (g) {
      return {
        id: g.id,
        daten: {
          titel: g.titel, portionen: g.portionen, zutaten: g.zutaten, naehrwerte: g.naehrwerte,
          notizen: g.notizen, erstellt: g.erstellt, geaendert: g.geaendert, khStufe: g.khStufe || "", ernaehrung: g.ernaehrung || ""
        },
        bild: g.bild || null,
        geloescht: !!g.geloescht,
        aktualisiert: g.aktualisiert
      };
    },
    vonServer: function (z) {
      const d = z.daten || {};
      return {
        id: z.id, titel: d.titel || "", bild: z.bild || null, portionen: d.portionen || 1,
        zutaten: d.zutaten || [], naehrwerte: d.naehrwerte || {}, notizen: d.notizen || "", khStufe: d.khStufe || "", ernaehrung: d.ernaehrung || "",
        erstellt: d.erstellt || z.aktualisiert, geaendert: d.geaendert || z.aktualisiert,
        geloescht: !!z.geloescht, aktualisiert: z.aktualisiert
      };
    }
  },
  {
    name: "wochenplan", speicher: "wochenplan", konflikt: "woche", block: 20,
    liste: function () { return Array.from(plaene.values()); },
    holen: function (schluessel) { return plaene.get(schluessel); },
    neuLaden: function () { return plaeneNeuLaden(); },
    schluesselLokal: function (r) { return r.woche; },
    schluesselServer: function (z) { return z.woche; },
    zuServer: function (p) { return { woche: p.woche, tage: p.tage, sport: sportTage(p), aktualisiert: p.aktualisiert }; },
    vonServer: function (z) { return { woche: z.woche, tage: z.tage, sport: sportTage(z), aktualisiert: z.aktualisiert }; }
  },
  {
    name: "einkauf_haken", speicher: "haken", konflikt: "woche,posten", block: 50,
    liste: function () { return Array.from(haken.values()); },
    holen: function (schluessel) { return haken.get(schluessel); },
    neuLaden: function () { return hakenNeuLaden(); },
    schluesselLokal: function (r) { return r.id; },
    schluesselServer: function (z) { return z.woche + "|" + z.posten; },
    zuServer: function (h) { return { woche: h.woche, posten: h.posten, erledigt: h.erledigt, aktualisiert: h.aktualisiert }; },
    vonServer: function (z) {
      return { id: z.woche + "|" + z.posten, woche: z.woche, posten: z.posten, erledigt: z.erledigt, aktualisiert: z.aktualisiert };
    }
  },
  {
    name: "einkauf_extra", speicher: "extras", konflikt: "id", block: 50,
    liste: function () { return Array.from(extras.values()); },
    holen: function (schluessel) { return extras.get(schluessel); },
    neuLaden: function () { return extrasNeuLaden(); },
    schluesselLokal: function (r) { return r.id; },
    schluesselServer: function (z) { return z.id; },
    zuServer: function (e) {
      return {
        id: e.id, woche: e.woche, daten: { name: e.name, menge: e.menge || "" },
        erledigt: !!e.erledigt, geloescht: !!e.geloescht, aktualisiert: e.aktualisiert
      };
    },
    vonServer: function (z) {
      const d = z.daten || {};
      return {
        id: z.id, woche: z.woche, name: d.name || "", menge: d.menge || "",
        erledigt: !!z.erledigt, geloescht: !!z.geloescht, aktualisiert: z.aktualisiert
      };
    }
  }
];

// Lädt lokal geänderte Einträge hoch. Der Server verwirft Änderungen, die älter sind als sein Stand.
async function pushen(spec) {
  const offen = spec.liste().filter(function (r) { return r.dirty; });
  for (let i = 0; i < offen.length; i += spec.block) {
    const teil = offen.slice(i, i + spec.block);
    const antwort = await sb.from(spec.name).upsert(teil.map(spec.zuServer), { onConflict: spec.konflikt });
    if (antwort.error) throw antwort.error;
    // Nur als "gesendet" markieren, was sich inzwischen nicht erneut geändert hat.
    const gesendet = teil.map(function (r) {
      const jetzt = spec.holen(spec.schluesselLokal(r));
      return jetzt && jetzt.aktualisiert === r.aktualisiert ? Object.assign({}, jetzt, { dirty: 0 }) : null;
    }).filter(Boolean);
    if (gesendet.length > 0) {
      await transaktion([spec.speicher], function (s) { gesendet.forEach(function (r) { s[spec.speicher].put(r); }); });
      await spec.neuLaden();
    }
  }
}

// Holt Einträge, die sich auf dem Server seit dem letzten Mal geändert haben.
// Rückgabe: true, wenn lokal etwas Neues angekommen ist.
async function pullen(spec) {
  const merkSchluessel = "sync." + KONFIG.url + "." + spec.name;
  const gemerkt = Number(merkenLesen(merkSchluessel)) || 0;
  // Ein kleiner Überlapp (50 Versionen) fängt Einträge ein, die gleichzeitig gespeichert wurden.
  // Ist lokal noch nichts vorhanden, wird ohnehin alles geholt.
  let cursor = spec.liste().length === 0 ? 0 : Math.max(0, gemerkt - 50);
  let hoechste = gemerkt;
  let geaendert = false;
  for (;;) {
    const antwort = await sb.from(spec.name).select("*").gt("version", cursor)
      .order("version", { ascending: true }).limit(50);
    if (antwort.error) throw antwort.error;
    const zeilen = antwort.data || [];
    const neue = [];
    zeilen.forEach(function (z) {
      const lokal = spec.holen(spec.schluesselServer(z));
      if (!lokal || z.aktualisiert > lokal.aktualisiert) neue.push(Object.assign(spec.vonServer(z), { dirty: 0 }));
    });
    if (neue.length > 0) {
      await transaktion([spec.speicher], function (s) { neue.forEach(function (r) { s[spec.speicher].put(r); }); });
      await spec.neuLaden();
      geaendert = true;
    }
    if (zeilen.length > 0) {
      cursor = zeilen[zeilen.length - 1].version;
      hoechste = Math.max(hoechste, cursor);
    }
    if (zeilen.length < 50) break;
  }
  merkenSchreiben(merkSchluessel, hoechste);
  return geaendert;
}

async function synchronisieren() {
  if (!sb) return;
  if (syncLaeuft) { syncNochmal = true; return; }
  syncLaeuft = true;
  try {
    const sitzung = await sb.auth.getSession();
    sbSitzung = sitzung && sitzung.data ? sitzung.data.session : null;
    if (!sbSitzung) { syncStatusSetzen("abgemeldet"); return; }
    syncStatusSetzen("laeuft");
    for (const spec of SYNC_TABELLEN) await pushen(spec);
    for (const spec of SYNC_TABELLEN) await pullen(spec);
    letzteSync = Date.now();
    syncStatusSetzen("ok");
  } catch (fehler) {
    const text = fehler && fehler.message ? fehler.message : "";
    syncStatusSetzen(navigator.onLine === false || /fetch|network|load failed/i.test(text) ? "offline" : "fehler", text);
  } finally {
    syncLaeuft = false;
    if (syncNochmal) { syncNochmal = false; setTimeout(synchronisieren, 300); }
  }
}

// Nach jeder lokalen Änderung kurz warten (mehrere Änderungen werden gebündelt) und dann abgleichen.
function syncAnstossen() {
  if (!sb) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(synchronisieren, 1500);
}

function syncStatusSetzen(status, meldung) {
  syncStatus = status;
  syncMeldung = meldung || "";
  anzeigeAktualisieren();
}

// Kleiner Knopf oben rechts: zeigt den Stand und öffnet die Konto-Ansicht.
function anzeigeAktualisieren() {
  const knopf = document.getElementById("sync-knopf");
  if (!knopf) return;
  if (!sb) { knopf.hidden = true; return; }
  const texte = { abgemeldet: "☁ Anmelden", laeuft: "⟳ Abgleich …", ok: "✓ Synchron", offline: "⚠ Offline", fehler: "⚠ Fehler" };
  knopf.hidden = false;
  knopf.textContent = texte[syncStatus] || "☁";
  knopf.className = "sync-knopf s-" + syncStatus;
}

function kontoOeffnen(beimStart) {
  if (!sb) return;
  const links = { text: beimStart ? "Später" : "Schließen", aktion: blattSchliessen };
  if (!sbSitzung) { anmeldeAnsicht(links); return; }

  const email = sbSitzung.user && sbSitzung.user.email ? sbSitzung.user.email : "";
  let zeile;
  if (syncStatus === "ok" && letzteSync) {
    zeile = "Zuletzt abgeglichen um " + new Date(letzteSync).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr.";
  } else if (syncStatus === "offline") {
    zeile = "Keine Verbindung. Deine Änderungen bleiben auf dem Gerät und werden nachgeholt, sobald du wieder online bist.";
  } else if (syncStatus === "fehler") {
    zeile = "Der letzte Abgleich hat nicht geklappt" + (syncMeldung ? ": " + syncMeldung : ".");
  } else {
    zeile = "Noch nicht abgeglichen.";
  }

  blattZeigen({
    titel: "Konto",
    links: links,
    inhalt: [
      el("div", { class: "karte" },
        el("p", { class: "leise", text: "Angemeldet als" }),
        el("h2", { text: email, style: "margin-top: 4px; overflow-wrap: anywhere" }),
        el("p", { style: "margin-top: 12px", text: zeile })
      ),
      el("div", { class: "reihe" },
        el("button", {
          class: "knopf knopf-primaer", type: "button", text: "Jetzt abgleichen",
          onclick: async function () { await synchronisieren(); if (!blatt.hidden) kontoOeffnen(false); }
        }),
        el("button", {
          class: "knopf knopf-gefahr", type: "button", text: "Abmelden",
          onclick: async function () {
            if (!confirm("Abmelden? Deine Daten bleiben auf diesem Gerät, werden aber nicht mehr abgeglichen.")) return;
            await sb.auth.signOut();
            sbSitzung = null;
            syncStatusSetzen("abgemeldet");
            blattSchliessen();
          }
        })
      )
    ]
  });
}

function anmeldeAnsicht(links) {
  const email = el("input", {
    type: "email", class: "eingabe", autocomplete: "username", autocapitalize: "off",
    placeholder: "E-Mail", "aria-label": "E-Mail"
  });
  const passwort = el("input", {
    type: "password", class: "eingabe", autocomplete: "current-password",
    placeholder: "Passwort", "aria-label": "Passwort"
  });
  const fehler = el("p", { class: "fehler", hidden: true });
  const knopf = el("button", { class: "knopf knopf-primaer", type: "button", style: "width: 100%", text: "Anmelden" });

  function fehlerZeigen(text) { fehler.textContent = text; fehler.hidden = false; }

  async function absenden() {
    fehler.hidden = true;
    if (!email.value.trim() || !passwort.value) return fehlerZeigen("Bitte E-Mail und Passwort eingeben.");
    knopf.disabled = true;
    knopf.textContent = "Anmelden …";
    try {
      const antwort = await sb.auth.signInWithPassword({ email: email.value.trim(), password: passwort.value });
      if (antwort.error) throw antwort.error;
      sbSitzung = antwort.data.session;
      blattSchliessen();
      anzeigeAktualisieren();
      synchronisieren();
    } catch (f) {
      const text = f && f.message ? f.message : "";
      if (/invalid login/i.test(text)) fehlerZeigen("E-Mail oder Passwort stimmt nicht.");
      else if (/fetch|network|load failed/i.test(text)) fehlerZeigen("Keine Verbindung zum Server.");
      else fehlerZeigen("Die Anmeldung hat nicht geklappt" + (text ? ": " + text : "."));
      knopf.disabled = false;
      knopf.textContent = "Anmelden";
    }
  }
  knopf.addEventListener("click", absenden);
  passwort.addEventListener("keydown", function (e) { if (e.key === "Enter") absenden(); });

  blattZeigen({
    titel: "Anmelden",
    links: links,
    inhalt: [
      el("p", { class: "leise", style: "margin-bottom: 16px", text: "Melde dich an, damit gleichen sich eure Gerichte, Wochenpläne und Einkaufslisten auf allen Geräten ab." }),
      el("label", { class: "feld" }, el("span", { text: "E-Mail" }), email),
      el("label", { class: "feld" }, el("span", { text: "Passwort" }), passwort),
      fehler,
      knopf
    ]
  });
}

// Richtet die Verbindung ein, falls in config.js ein Supabase-Projekt eingetragen ist.
function syncEinrichten() {
  if (!KONFIG.url || !KONFIG.key || !window.supabase || !window.supabase.createClient) return false;
  sb = window.supabase.createClient(KONFIG.url, KONFIG.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  sb.auth.onAuthStateChange(function (ereignis, sitzung) { sbSitzung = sitzung; anzeigeAktualisieren(); });
  document.getElementById("sync-knopf").addEventListener("click", function () { kontoOeffnen(false); });
  window.addEventListener("online", function () { synchronisieren(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") synchronisieren();
  });
  setInterval(function () { if (document.visibilityState === "visible") synchronisieren(); }, 30000);
  return true;
}

/* ---------- Start ---------- */

/* ---------- Einstellungen: Farbvarianten ---------- */

const SKINS = [
  { id: "schiefer", name: "Schiefer & Bernstein", art: "dunkel", bg: "#2a313c", meta: "#2a313c", farben: ["#2a313c", "#323a47", "#f5b73c", "#eef1f5"] },
  { id: "pastell", name: "Pastel garden", art: "hell", meta: "#f7e6e4", farben: ["#f7e6e4", "#fcf1ef", "#c75f71", "#54463a"] },
  { id: "tusche", name: "Ink wash", art: "hell", meta: "#f1f0e2", farben: ["#f1f0e2", "#f9f8ed", "#5f7489", "#3a3a3a"] },
  { id: "sturm", name: "Stormy morning", art: "dunkel", meta: "#2e3c4a", farben: ["#2e3c4a", "#384959", "#88bdf2", "#ebf3fb"] },
  { id: "nacht", name: "Night Pastel", art: "dunkel", meta: "#121212", farben: ["#121212", "#1c1c1c", "#f6f3a8", "#9dc3d4"] }
];

function skinLesen() {
  try { const s = localStorage.getItem("essensplan-skin"); if (SKINS.some(function (x) { return x.id === s; })) return s; } catch (e) {}
  return "schiefer";
}

function skinAnwenden(id) {
  const skin = SKINS.find(function (x) { return x.id === id; }) || SKINS[0];
  if (skin.id === "schiefer") delete document.documentElement.dataset.skin;
  else document.documentElement.dataset.skin = skin.id;
  const tc = document.querySelector('meta[name="theme-color"]');
  const cs = document.querySelector('meta[name="color-scheme"]');
  if (tc) tc.content = skin.meta;
  if (cs) cs.content = skin.art === "hell" ? "light" : "dark";
  try { localStorage.setItem("essensplan-skin", skin.id); } catch (e) {}
}

function einstellungenOeffnen() {
  const liste = el("div", { class: "skin-liste" });
  function zeichnen() {
    const aktuell = skinLesen();
    liste.replaceChildren.apply(liste, SKINS.map(function (skin) {
      return el("button", {
        class: "skin-kachel" + (skin.id === aktuell ? " aktiv" : ""), type: "button", "data-skin": skin.id,
        onclick: function () { skinAnwenden(skin.id); zeichnen(); }
      },
        el("div", { class: "skin-farben" }, skin.farben.map(function (f) { return el("span", { style: "background:" + f }); })),
        el("span", { class: "skin-name" }, skin.name, el("small", { text: skin.art === "hell" ? "hell" : "dunkel" }))
      );
    }));
  }
  zeichnen();
  blattZeigen({
    titel: "Einstellungen",
    links: { text: "Schließen", aktion: blattSchliessen },
    inhalt: [
      el("h3", { class: "abschnitt", text: "Farbvariante" }),
      liste,
      el("p", { class: "leise", style: "margin-top: 16px", text: "Die Wahl gilt nur für dieses Gerät." })
    ]
  });
}

async function start() {
  wochenWischenEinrichten();
  suchzeileScrollEinrichten();
  document.getElementById("einstellungen-knopf").addEventListener("click", einstellungenOeffnen);
  navigationEinrichten();
  try {
    db = await datenbankOeffnen();
    await datenMigrieren();
    await alleNeuLaden();
    // Bittet das iPhone, die Daten nicht automatisch zu löschen.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (fehler) {
    document.getElementById("gerichte").replaceChildren(
      el("div", { class: "karte" },
        el("h2", { text: "Speicher nicht verfügbar" }),
        el("p", { text: "Die App kann auf diesem Gerät gerade nichts speichern. Bitte nicht im privaten Modus öffnen." })
      )
    );
    return;
  }

  // Synchronisierung: nur aktiv, wenn config.js ausgefüllt ist.
  if (!syncEinrichten()) return;
  anzeigeAktualisieren();
  try {
    const sitzung = await sb.auth.getSession();
    sbSitzung = sitzung && sitzung.data ? sitzung.data.session : null;
  } catch (fehler) {
    sbSitzung = null;
  }
  if (sbSitzung) {
    synchronisieren();
  } else {
    syncStatusSetzen("abgemeldet");
    kontoOeffnen(true);
  }
}

/* ---------- Startbild ---------- */

const SPLASH_MINDESTDAUER = 1100;
const SPLASH_START = Date.now();
let splashWeg = false;
function splashAusblenden() {
  if (splashWeg) return;
  splashWeg = true;
  const sp = document.getElementById("splash");
  if (!sp) return;
  const warte = Math.max(0, SPLASH_MINDESTDAUER - (Date.now() - SPLASH_START));
  setTimeout(function () {
    sp.classList.add("weg");
    setTimeout(function () { sp.remove(); }, 600);
  }, warte);
}
setTimeout(splashAusblenden, 6000); // Sicherheitsnetz, falls beim Start etwas hängt

start().then(splashAusblenden, splashAusblenden);

/* ---------- Offline-Fähigkeit und automatische Updates ---------- */

if ("serviceWorker" in navigator) {
  const hatteSchonEinen = !!navigator.serviceWorker.controller;
  let neuGeladen = false;
  // Kommt eine neue App-Version, wird die Seite einmal automatisch neu geladen.
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (hatteSchonEinen && !neuGeladen) {
      neuGeladen = true;
      location.reload();
    }
  });
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function (fehler) {
      console.log("Service Worker konnte nicht registriert werden:", fehler);
    });
  });
}
