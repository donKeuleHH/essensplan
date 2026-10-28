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
    const anfrage = indexedDB.open("essensplan", 8);
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
      // Ab Version 6: Vorrat (Zutaten, die immer da sind und nicht auf die Einkaufsliste sollen)
      if (!d.objectStoreNames.contains("vorrat")) {
        d.createObjectStore("vorrat", { keyPath: "id" });
      }
      // Ab Version 7: von Hand geänderte Abteilungen einzelner Zutaten
      if (!d.objectStoreNames.contains("abteilungen")) {
        d.createObjectStore("abteilungen", { keyPath: "id" });
      }
      // Ab Version 8: eigene Abteilungen, Emojis und Reihenfolge
      if (!d.objectStoreNames.contains("abteilungsliste")) {
        d.createObjectStore("abteilungsliste", { keyPath: "id" });
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
let abteilungsListeRoh = new Map(); // eigene Abteilungen und Änderungen an den eingebauten: Schlüssel = id
let abteilungsWahl = new Map(); // von Hand gewählte Abteilungen: Schlüssel = id (aus dem Namen abgeleitet)
let vorrat = new Map();      // Vorrat: Schlüssel = id (inkl. gelöschter)
let extras = new Map();      // eigene Artikel auf der Einkaufsliste: Schlüssel = id (inkl. gelöschter, für Vorschläge)
let extraEntwurf = { name: "", menge: "", einheit: "Stück", abt: "" }; // halb getippter Artikel bleibt beim Neuzeichnen erhalten

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
      const vorher = document.querySelector("nav button.aktiv");
      if (vorher && vorher.dataset.ziel === "einkauf") einkaufGesehenMerken();
      reiter.forEach(function (k) { k.classList.remove("aktiv"); });
      ansichten.forEach(function (a) { a.classList.remove("aktiv"); });
      knopf.classList.add("aktiv");
      document.getElementById(knopf.dataset.ziel).classList.add("aktiv");
      titel.textContent = knopf.dataset.titel;
      modiBeenden();
      sportKnopfZeigen();
      if (knopf.dataset.ziel === "wochenplan") wochenplanZeichnen();
      if (knopf.dataset.ziel === "einkauf") einkaufZeichnen();
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

// Zeigt den Zubereitungstext hübscher an: "1. …"-Zeilen werden zu nummerierten Schritt-Karten,
// "Abschnitt:"-Zeilen zu Zwischenüberschriften, Zeitangaben und Quelle klein und grau.
// Ohne nummerierte Zeilen bleibt es einfacher Text. Gespeichert wird immer der Originaltext.
function zubereitungKnoten(text) {
  const zeilen = String(text || "").split(/\r?\n/);
  const schrittRegel = /^\s*(?:schritt\s*)?(\d{1,2})\s*[.):]\s+(\S.*)$/i;
  if (!zeilen.some(function (z) { return schrittRegel.test(z); })) {
    return el("p", { class: "notizen", text: text });
  }
  const box = el("div", { class: "zub" });
  let absatz = [];
  function absatzAbschliessen() {
    if (absatz.length) box.append(el("p", { class: "notizen zub-text", text: absatz.join("\n") }));
    absatz = [];
  }
  zeilen.forEach(function (roh) {
    const z = roh.trim();
    if (z === "") { absatzAbschliessen(); return; }
    const s = schrittRegel.exec(z);
    if (s) {
      absatzAbschliessen();
      box.append(el("div", { class: "zub-schritt" },
        el("span", { class: "zub-nr", text: s[1] }),
        el("div", { class: "zub-satz", text: s[2] })));
    } else if (/^(vorbereiten|zubereitung|kochen|backen|gesamt|ruhen)\b.*\bmin\b/i.test(z)) {
      absatzAbschliessen();
      box.append(el("p", { class: "zub-meta", text: z }));
    } else if (/^quelle:/i.test(z)) {
      absatzAbschliessen();
      box.append(el("p", { class: "zub-quelle", text: z }));
    } else if (z.length <= 60 && /:$/.test(z)) {
      absatzAbschliessen();
      box.append(el("h4", { class: "zub-abschnitt", text: z.slice(0, -1) }));
    } else {
      absatz.push(z);
    }
  });
  absatzAbschliessen();
  return box;
}

// wahl (optional): kommt vom Tag-Auswahlfenster. Dann gibt es „Übernehmen“ und „Zurück“ statt Bearbeiten/Löschen.
function detailOeffnen(id, wahl) {
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
      return el("div", { class: "nw-kachel" },
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
    inhalt.push(el("h3", { class: "abschnitt", text: "Zubereitung" }));
    inhalt.push(zubereitungKnoten(g.notizen));
  }

  if (wahl) {
    const zurueck = function () { gerichtWaehlen(wahl.index, wahl.aktuelleId); };
    inhalt.push(el("div", { style: "margin-top: 28px" },
      el("button", { class: "knopf knopf-primaer", type: "button", style: "width: 100%",
        onclick: function () { tagSetzen(wahl.montag, wahl.index, g.id); },
        text: "Für " + TAGNAMEN[wahl.index] + " übernehmen" })
    ));
    inhalt.push(el("div", { class: "reihe" },
      el("button", { class: "knopf knopf-sekundaer", type: "button", style: "width: 100%", onclick: zurueck, text: "Zurück" })
    ));
  } else {
    inhalt.push(el("div", { class: "reihe", style: "margin-top: 28px" },
      el("button", { class: "knopf knopf-primaer", type: "button", onclick: function () { formularOeffnen(g); }, text: "Bearbeiten" }),
      el("button", { class: "knopf knopf-sekundaer", type: "button", onclick: function () { gerichtKopieren(g); }, text: "Kopieren" })
    ));
    inhalt.push(el("div", { class: "reihe" },
      el("button", { class: "knopf knopf-gefahr", type: "button", onclick: function () { gerichtLoeschen(g); }, text: "Löschen" })
    ));
  }

  blattZeigen({
    titel: "Gericht",
    links: wahl
      ? { text: "Zurück", aktion: function () { gerichtWaehlen(wahl.index, wahl.aktuelleId); } }
      : { text: "Schließen", aktion: blattSchliessen },
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
    class: "eingabe", rows: "8", placeholder: "Schritte, Tipps, Varianten …"
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
      el("label", { class: "feld" }, el("span", { text: "Zubereitung (optional)" }), notizenFeld),
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
const IMPORT_GANZE = { "Stück": 0.5, Dose: 0.5, Packung: 0.5, Bund: 0.5, Prise: 0.5 };

function importPersonenLesen() {
  try { const n = Number(localStorage.getItem("essensplan-import-personen")); if (Number.isInteger(n) && n >= 1 && n <= 12) return n; } catch (e) {}
  return 2;
}

function rezeptZuGericht(r, ziel) {
  const zutaten = [];
  const original = r.portionen && r.portionen > 0 ? r.portionen : null;
  const zielPortionen = ziel && ziel > 0 ? ziel : (original || 2);
  const faktor = original ? zielPortionen / original : 1;
  const hinweise = [];
  (r.zutaten || []).forEach(function (zeile) {
    const z = zutatZerlegen(zeile);
    let menge = z.menge;
    if (menge !== null && faktor !== 1) {
      menge = menge * faktor;
      const schritt = IMPORT_GANZE[z.einheit];
      menge = schritt ? Math.max(schritt, Math.round(menge / schritt) * schritt) : Math.round(menge * 100) / 100;
    }
    zutaten.push({ name: z.name, menge: menge, einheit: z.einheit });
    if (z.hinweis) hinweise.push("- " + z.name + ": " + z.hinweis);
  });
  const teile = [];
  if (original && faktor !== 1) teile.push("Originalrezept für " + zahlText(original) + " Portionen, hier auf " + zahlText(zielPortionen) + " umgerechnet.");
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
    portionen: zielPortionen,
    zutaten: zutaten.length ? zutaten : [{ name: "", menge: null, einheit: "g" }],
    naehrwerte: { kcal: n.kcal === undefined ? null : n.kcal, eiweiss: n.eiweiss === undefined ? null : n.eiweiss,
      kohlenhydrate: n.kohlenhydrate === undefined ? null : n.kohlenhydrate, fett: n.fett === undefined ? null : n.fett },
    notizen: teile.join("\n\n")
  };
}

// Ruft den Importhelfer in Supabase auf. Liefert das fertige Gericht oder wirft eine Fehlermeldung als Text.
async function rezeptHolen(adresse, personen) {
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
  return rezeptZuGericht(r, personen);
}

function importKarte(beiErfolg) {
  const feld = el("input", { type: "url", class: "eingabe", placeholder: "https://…", autocomplete: "off", autocapitalize: "off", inputmode: "url" });
  const meldung = el("p", { class: "leise", hidden: true });
  const personen = el("select", { class: "eingabe", "aria-label": "Für wie viele Personen" },
    [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) { return el("option", { value: String(n), text: n === 1 ? "1 Person" : n + " Personen" }); }));
  personen.value = String(importPersonenLesen());
  const knopf = el("button", { class: "knopf knopf-sekundaer", type: "button", style: "width: 100%", text: "Importieren" });
  knopf.addEventListener("click", async function () {
    const adresse = feld.value.trim();
    if (!adresse) { meldung.textContent = "Bitte füge zuerst einen Link ein."; meldung.hidden = false; return; }
    knopf.disabled = true; knopf.textContent = "Lade Rezept …"; meldung.hidden = true;
    try {
      try { localStorage.setItem("essensplan-import-personen", personen.value); } catch (e) {}
      beiErfolg(await rezeptHolen(adresse, Number(personen.value)));
    } catch (f) {
      meldung.textContent = f.message; meldung.hidden = false;
      knopf.disabled = false; knopf.textContent = "Importieren";
    }
  });
  const inhalt = el("div", { class: "import-inhalt", hidden: true },
    el("p", { class: "leise", text: "Link einer Rezeptseite einfügen. Titel, Zutaten, Anleitung (unter Zubereitung), Nährwerte und Foto werden übernommen." }),
    feld,
    el("label", { class: "feld", style: "margin-top: 10px" }, el("span", { text: "Kochen für (Mengen werden umgerechnet)" }), personen),
    knopf, meldung
  );
  const kopf = el("button", { class: "import-kopf", type: "button", "aria-expanded": "false" },
    el("span", { class: "import-titel", text: "🔗 Rezept aus Link importieren" }),
    el("span", { class: "import-pfeil", text: "›" })
  );
  const huelle = el("div", { class: "karte import-karte" }, kopf, inhalt);
  kopf.addEventListener("click", function () {
    const offen = inhalt.hidden;
    inhalt.hidden = !offen;
    huelle.classList.toggle("offen", offen);
    kopf.setAttribute("aria-expanded", offen ? "true" : "false");
    if (offen) feld.focus();
  });
  return huelle;
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
  modiBeenden();
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
// icons (optional): eigene Rundknöpfe statt „Plan teilen“, z. B. auf der Zutaten-Seite.
function wochenKopf(icons) {
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
    const zurueck = el("button", {
      class: "textknopf", type: "button",
      onclick: function () { modiBeenden(); angezeigteWoche = standardWoche(); wochenAnsichtenZeichnen(); }
    });
    zurueck.innerHTML = RUECK_ICON;
    zurueck.append(" Zu KW " + kalenderwoche(standard));
    aktionen.append(zurueck);
  } else {
    aktionen.append(el("span"));
  }
  const iconBox = el("div", { class: "woche-icons" });
  if (icons) {
    icons.forEach(function (i) {
      iconBox.append(el("button", {
        class: "rundknopf-klein", type: "button", "aria-label": i.beschriftung, title: i.beschriftung, onclick: i.aktion
      }, i.knoten));
    });
  } else {
    iconBox.append(el("button", {
      class: "rundknopf-klein", type: "button", "aria-label": "Plan teilen", title: "Plan teilen",
      onclick: function () { planTeilenOeffnen(); }
    }, teilenIconKnoten()));
  }
  aktionen.append(iconBox);
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
    const istSport = sportModus && sportAuswahl ? sportAuswahl[i] : sportTage(plan)[i];
    const auswaerts = id === AUSWAERTS;
    const sig = [i, datumSchluessel(tag), datumSchluessel(tag) === heute, auswaerts, g ? g.id + "|" + g.titel + "|" + g.portionen + "|" + (g.bild ? g.bild.length : 0) + "|" + JSON.stringify(g.naehrwerte || null) : ""].join("#");
    // Unveränderte Kachel behalten (kein Neuladen des Bildes, sonst flackert es);
    // nur das Sport-Zeichen wird an Ort und Stelle angepasst.
    const vorhanden = Array.prototype.find.call(box.children, function (k) { return k.dataset && k.dataset.sig === sig; });
    if (vorhanden) {
      sportZeichenSetzen(vorhanden, istSport, i);
      loeschZeichenSetzen(vorhanden, i);
      teile.push(vorhanden);
    } else {
      const neu = tagKarte(i, tag, g || null, datumSchluessel(tag) === heute, istSport, auswaerts);
      neu.dataset.sig = sig;
      loeschZeichenSetzen(neu, i);
      teile.push(neu);
    }
  }
  if (loeschModus && loeschAuswahl) {
    const belegte = loeschBelegt();
    const anzahl = loeschAuswahl.filter(Boolean).length;
    teile.splice(1, 1, el("div", { class: "sport-hinweis loesch-hinweis" },
      el("span", { text: anzahl + " gewählt" }),
      el("button", { type: "button", class: "leise-knopf", onclick: function () { loeschAlleUmschalten(); }, text: "Alle" }),
      el("button", { type: "button", class: "gefahr-knopf", disabled: anzahl === 0 || undefined, onclick: function () { loeschAusfuehren(); }, text: "Entfernen" }),
      el("button", { type: "button", class: "zu-knopf", "aria-label": "Abbrechen", onclick: function () { loeschModusBeenden(); wochenplanZeichnen(); }, text: "✕" })));
  } else {
    const hantel = el("button", {
      class: "rundknopf-klein" + (sportModus ? " an" : ""), type: "button", id: "sport-knopf",
      "aria-label": "Sporttage wählen", "aria-pressed": sportModus ? "true" : "false", title: "Sporttage wählen",
      onclick: function () { sportModusUmschalten(); }
    });
    hantel.innerHTML = SPORT_ICON;
    teile[1].querySelector(".woche-icons").prepend(hantel);
    teile[1].querySelector(".woche-icons").append(el("button", {
      class: "rundknopf-klein", type: "button", "aria-label": "Gerichte entfernen", title: "Gerichte entfernen",
      onclick: function () { loeschModusStarten(); }
    }, loeschIconKnoten()));
  }
  if (sportModus) {
    teile.splice(2, 0, el("div", { class: "sport-hinweis" },
      el("span", { text: "Sporttage antippen" }),
      el("button", { type: "button", onclick: function () { sportModusUmschalten(); }, text: "Fertig" })));
  }
  box.replaceChildren.apply(box, teile);
}

const RUECK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
const AUSWAERTS = "auswaerts";
const AUSWAERTS_PFAD = "M6 3v6a2 2 0 0 0 4 0V3M8 3v18M16 21V3c-2 2-3 5-3 8h3";
const AUSWAERTS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + AUSWAERTS_PFAD + '"/></svg>';

// Ein Tag im Wochenplan: Bildkachel mit Tagesmarke, Name und kurzer Info.
function tagKarte(index, tag, g, istHeute, istSport, auswaerts) {
  let bild;
  if (auswaerts) { bild = el("div", { class: "wk-bild wk-aus" }); bild.innerHTML = AUSWAERTS_ICON; }
  else if (g && g.bild) bild = el("img", { class: "wk-bild", src: g.bild, alt: "", draggable: "false" });
  else if (g) bild = kreisBild(g.titel, "wk-bild");
  else bild = el("div", { class: "wk-bild wk-leer" }, el("span", { text: "+" }));
  const marke = el("span", { class: "wk-tag" + (istHeute ? " heute" : "") }, TAGKURZ[index] + " · " + kurzDatum(tag));
  const kopf = el("div", { class: "wk-kopf" }, marke);
  let text;
  if (auswaerts) {
    text = [el("h3", { text: "Auswärts essen" }), el("p", { text: "Kein Gericht geplant" })];
  } else if (g) {
    const kcal = g.naehrwerte && g.naehrwerte.kcal !== null && g.naehrwerte.kcal !== undefined ? " · " + zahlText(g.naehrwerte.kcal) + " kcal" : "";
    text = [el("h3", { text: g.titel }), el("p", { text: zahlText(g.portionen) + " Port." + kcal })];
  } else {
    text = [el("h3", { class: "wk-offen", text: "Gericht wählen" })];
  }
  const karte = el("button", {
    class: "wk" + (istHeute ? " heute" : ""), type: "button",
    onclick: function () {
      if (sportModus && sportAuswahl) {
        sportAuswahl[index] = !sportAuswahl[index];
        sportZeichenSetzen(karte, sportAuswahl[index], index);
      } else if (loeschModus && loeschAuswahl) {
        if (karte.dataset.belegt !== "1") return;
        loeschAuswahl[index] = !loeschAuswahl[index];
        loeschZeichenSetzen(karte, index);
        wochenplanZeichnen();
      } else {
        gerichtWaehlen(index, auswaerts ? AUSWAERTS : (g ? g.id : null));
      }
    }
  }, el("div", { class: "wk-fenster" }, bild, kopf), el("div", { class: "wk-text" }, text));
  karte.dataset.belegt = (auswaerts || g) ? "1" : "0";
  sportZeichenSetzen(karte, istSport, index);
  return karte;
}

// Sport-Zeichen einer Kachel: im Sport-Modus ein Kreis mit Haken, sonst das Hantel-Abzeichen.
function sportZeichenSetzen(karte, istSport, index) {
  const kopf = karte.querySelector(".wk-kopf");
  const fenster = karte.querySelector(".wk-fenster");
  let badge = kopf.querySelector(".wk-sport");
  let haken = fenster.querySelector(".wk-haken:not(.loesch)");
  if (sportModus) {
    if (badge) badge.remove();
    if (!haken) { haken = el("span", { class: "wk-haken" }); fenster.appendChild(haken); }
    haken.classList.toggle("an", !!istSport);
    haken.textContent = istSport ? "✓" : "";
    karte.classList.toggle("gew", !!istSport);
    karte.setAttribute("aria-label", TAGNAMEN[index] + (istSport ? ", als Sporttag gewählt" : ", kein Sporttag"));
  } else {
    if (haken) haken.remove();
    karte.classList.remove("gew");
    if (istSport && !badge) {
      badge = el("span", { class: "sport-badge wk-sport", title: "Sporttag" });
      badge.innerHTML = SPORT_ICON;
      kopf.appendChild(badge);
    } else if (!istSport && badge) badge.remove();
    karte.setAttribute("aria-label", TAGNAMEN[index] + (istSport ? ", Sporttag" : ""));
  }
}

// Die zuletzt eingeplanten Gerichte (Vergangenheit und laufende Woche), neueste zuerst.
function zuletztGeplanteGerichte(ohneId, maximal) {
  const heute = new Date();
  const heuteSchluessel = datumSchluessel(heute);
  const dieseWoche = datumSchluessel(montagVon(heute));
  const juengster = new Map();
  plaene.forEach(function (plan, woche) {
    if (woche > dieseWoche) return;
    const montag = new Date(Number(woche.slice(0, 4)), Number(woche.slice(5, 7)) - 1, Number(woche.slice(8, 10)), 12);
    (plan.tage || []).forEach(function (id, i) {
      if (id === null || id === undefined || id === AUSWAERTS) return;
      const tag = tagVerschieben(montag, i);
      const k = datumSchluessel(tag);
      if (!juengster.has(id) || juengster.get(id).k < k) juengster.set(id, { k: k, tag: tag });
    });
  });
  const treffer = [];
  juengster.forEach(function (v, id) {
    if (id === ohneId) return;
    const g = gerichte.find(function (x) { return x.id === id; });
    if (g) treffer.push({ g: g, k: v.k, tag: v.tag });
  });
  treffer.sort(function (a, b) { return a.k < b.k ? 1 : a.k > b.k ? -1 : 0; });
  return treffer.slice(0, maximal).map(function (t) {
    const diff = Math.round((new Date(heute.getFullYear(), heute.getMonth(), heute.getDate(), 12) - t.tag) / 86400000);
    let wann;
    if (diff < 0) wann = "diese Woche";
    else if (diff === 0) wann = "heute";
    else if (diff === 1) wann = "gestern";
    else if (diff < 14) wann = "vor " + diff + " Tagen";
    else wann = "vor " + Math.round(diff / 7) + " Wochen";
    return { g: t.g, wann: wann };
  });
}

// Zeigt die Gerichte zur Auswahl für einen Tag der gerade angezeigten Woche.
function gerichtWaehlen(index, aktuelleId) {
  const montag = angezeigteWoche;
  const tag = tagVerschieben(montag, index);
  const liste = el("div", { style: "margin-top: 14px" });
  const aktuellesGericht = gerichte.find(function (x) { return x.id === aktuelleId; }) || null;
  const auswahlFilter = { kh: "", ern: "" };
  let suchtext = "";
  const zuletztListe = zuletztGeplanteGerichte(aktuelleId, 6);
  const zuletzt = zuletztListe.length === 0 ? null : el("div", { class: "zuletzt" },
    el("h4", { text: "Zuletzt verwendet" }),
    el("div", { class: "zuletzt-reihe" }, zuletztListe.map(function (z) {
      const bild = z.g.bild ? el("img", { class: "zuletzt-bild", src: z.g.bild, alt: "", draggable: "false" }) : kreisBild(z.g.titel, "zuletzt-bild");
      return el("div", { class: "zuletzt-zelle" },
        el("button", { class: "zuletzt-kachel", type: "button", onclick: function () { tagSetzen(montag, index, z.g.id); } },
          bild, el("div", { class: "zuletzt-text" }, el("strong", { text: z.g.titel }), el("small", { text: z.wann }))),
        el("button", {
          class: "waehl-info zuletzt-info", type: "button", "aria-label": "Rezept ansehen: " + z.g.titel, text: "i",
          onclick: function () { detailOeffnen(z.g.id, { index: index, montag: montag, aktuelleId: aktuelleId }); }
        }));
    })));
  const kopfzeile = suchZeile({
    zustand: auswahlFilter, wert: "", umschalter: false,
    beiEingabe: function (t) { suchtext = t; listeZeichnen2(); },
    beiFilter: function () { listeZeichnen2(); }
  });

  function listeZeichnen2() {
    if (zuletzt) zuletzt.hidden = !!(suchtext.trim() || auswahlFilter.kh || auswahlFilter.ern);
    const treffer = gerichte
      .filter(function (g) { return g.id !== aktuelleId && gerichtTrifft(g, auswahlFilter, suchtext); })
      .sort(function (a, b) { return a.titel.localeCompare(b.titel, "de"); });
    if (gerichte.length === 1 && aktuellesGericht && treffer.length === 0 && !suchtext.trim()) {
      liste.replaceChildren();
    } else if (gerichte.length === 0) {
      liste.replaceChildren(el("div", { class: "karte" },
        el("p", { text: "Du hast noch keine Gerichte angelegt. Lege sie zuerst im Reiter „Gerichte“ an." })));
    } else if (treffer.length === 0) {
      liste.replaceChildren(el("p", { class: "leise", text: "Kein Gericht gefunden." }));
    } else {
      liste.replaceChildren.apply(liste, treffer.map(function (g) {
        return el("div", { class: "waehl-zeile" },
          gerichtKarte(g, function () { tagSetzen(montag, index, g.id); }),
          el("button", {
            class: "waehl-info", type: "button", "aria-label": "Rezept ansehen: " + g.titel, text: "i",
            onclick: function () { detailOeffnen(g.id, { index: index, montag: montag, aktuelleId: aktuelleId }); }
          }));
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
      aktuellesGericht
        ? el("div", { class: "aktuell-karte" },
            el("div", { class: "aktuell-label", text: "Aktuell am " + TAGNAMEN[index] }),
            el("div", { class: "waehl-zeile" },
              gerichtKarte(aktuellesGericht, function () { detailOeffnen(aktuellesGericht.id, { index: index, montag: montag, aktuelleId: aktuelleId }); }),
              el("button", {
                class: "waehl-info", type: "button", "aria-label": "Rezept ansehen: " + aktuellesGericht.titel, text: "i",
                onclick: function () { detailOeffnen(aktuellesGericht.id, { index: index, montag: montag, aktuelleId: aktuelleId }); }
              })),
            el("button", {
              class: "aktuell-entfernen", type: "button",
              onclick: function () { tagSetzen(montag, index, null); },
              text: "Gericht für diesen Tag entfernen"
            }))
        : (aktuelleId !== null && aktuelleId !== undefined
            ? el("button", {
                class: "knopf knopf-gefahr", type: "button", style: "width: 100%",
                onclick: function () { tagSetzen(montag, index, null); },
                text: aktuelleId === AUSWAERTS ? "Auswärts essen entfernen" : "Gericht für diesen Tag entfernen"
              })
            : null),
      auswaertsKnopf,
      zuletzt,
      gerichte.length > 0 ? kopfzeile : null,
      liste
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
/* ---------- Entfernen-Modus ---------- */

let loeschModus = false;
let loeschAuswahl = null;

function loeschIconKnoten() {
  const k = document.createElement("span");
  k.className = "teilen-icon";
  k.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  return k;
}

function modiBeenden() { sportModusBeenden(); loeschModusBeenden(); }

// Welche Tage der angezeigten Woche haben ein Gericht oder „Auswärts essen“?
function loeschBelegt() {
  const plan = plaene.get(datumSchluessel(angezeigteWoche));
  const r = [];
  for (let i = 0; i < 5; i++) {
    const id = plan ? plan.tage[i] : null;
    r.push(id === AUSWAERTS || (id !== null && id !== undefined && gerichte.some(function (x) { return x.id === id; })));
  }
  return r;
}

function loeschModusStarten() {
  sportModusBeenden();
  loeschModus = true;
  loeschAuswahl = [false, false, false, false, false];
  sportKnopfZeigen();
  wochenplanZeichnen();
}

function loeschModusBeenden() {
  loeschModus = false; loeschAuswahl = null;
}

function loeschAlleUmschalten() {
  const belegt = loeschBelegt();
  const alleGewaehlt = belegt.every(function (b, i) { return !b || loeschAuswahl[i]; });
  loeschAuswahl = belegt.map(function (b) { return alleGewaehlt ? false : b; });
  wochenplanZeichnen();
}

// Kreis mit Haken auf den belegten Kacheln, leere Kacheln werden abgedunkelt.
function loeschZeichenSetzen(karte, index) {
  const fenster = karte.querySelector(".wk-fenster");
  let haken = fenster.querySelector(".wk-haken.loesch");
  if (!loeschModus || !loeschAuswahl) {
    if (haken) haken.remove();
    karte.classList.remove("gew-loesch", "aus");
    return;
  }
  const belegt = karte.dataset.belegt === "1";
  karte.classList.toggle("aus", !belegt);
  if (!belegt) { if (haken) haken.remove(); karte.classList.remove("gew-loesch"); return; }
  if (!haken) { haken = el("span", { class: "wk-haken loesch" }); fenster.appendChild(haken); }
  const an = !!loeschAuswahl[index];
  haken.classList.toggle("an", an);
  haken.textContent = an ? "✓" : "";
  karte.classList.toggle("gew-loesch", an);
  karte.setAttribute("aria-label", TAGNAMEN[index] + (an ? ", zum Entfernen gewählt" : ", nicht gewählt"));
}

async function loeschAusfuehren() {
  const tage = [];
  loeschAuswahl.forEach(function (v, i) { if (v) tage.push(i); });
  if (tage.length === 0) return;
  const text = tage.length === 1 ? "1 Gericht aus dem Plan entfernen?" : tage.length + " Gerichte aus dem Plan entfernen?";
  if (!confirm(text)) return;
  const montag = angezeigteWoche;
  const schluessel = datumSchluessel(montag);
  const alt = plaene.get(schluessel);
  const plan = {
    woche: schluessel,
    tage: alt ? alt.tage.slice() : [null, null, null, null, null],
    sport: sportTage(alt),
    aktualisiert: zeitNach(alt),
    dirty: 1
  };
  tage.forEach(function (i) { plan.tage[i] = null; });
  loeschModusBeenden();
  try {
    await schreiben("wochenplan", function (st) { return st.put(plan); });
    await plaeneNeuLaden();
    syncAnstossen();
  } catch (fehler) {
    alert("Das Speichern hat leider nicht geklappt.");
    wochenplanZeichnen();
  }
}

let sportModus = false;
let sportAuswahl = null;
let sportMontag = null;

function sportModusUmschalten() {
  if (sportModus) { sportModusBeenden(); wochenplanZeichnen(); return; }
  loeschModusBeenden();
  sportModus = true;
  sportMontag = angezeigteWoche;
  sportAuswahl = sportTage(plaene.get(datumSchluessel(sportMontag))).slice();
  sportKnopfZeigen();
  wochenplanZeichnen();
}

// Beendet den Modus und speichert die Auswahl (wenn sie sich geändert hat). Zeichnet nicht selbst neu.
function sportModusBeenden() {
  if (!sportModus) return;
  const montag = sportMontag, auswahl = sportAuswahl;
  sportModus = false; sportAuswahl = null; sportMontag = null;
  sportKnopfZeigen();
  const alt = plaene.get(datumSchluessel(montag));
  const vorher = sportTage(alt);
  if (auswahl.every(function (v, i) { return !!v === !!vorher[i]; })) return;
  sportSpeichern(montag, auswahl);
}

function sportKnopfZeigen() { /* Der Knopf wird mit dem Wochenplan neu gezeichnet. */ }

async function sportSpeichern(montag, sport) {
  const schluessel = datumSchluessel(montag);
  const alt = plaene.get(schluessel);
  const plan = {
    woche: schluessel,
    tage: alt ? alt.tage.slice() : [null, null, null, null, null],
    sport: sport.map(function (v) { return !!v; }),
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

/* ---------- Abteilungen im Supermarkt ---------- */

const ABTEILUNGEN_STANDARD = [
  { id: "obst", name: "Obst & Gemüse", emoji: "🥦" },
  { id: "fleisch", name: "Fleisch & Fisch", emoji: "🥩" },
  { id: "kuehl", name: "Kühlregal", emoji: "🥛" },
  { id: "back", name: "Backwaren", emoji: "🍞" },
  { id: "trocken", name: "Trockenware & Konserven", emoji: "🥫" },
  { id: "gewuerz", name: "Gewürze & Öle", emoji: "🧂" },
  { id: "getraenke", name: "Getränke", emoji: "🥤" },
  { id: "sonstiges", name: "Sonstiges", emoji: "🛒" }
];

// Eingebaute Abteilungen (Emoji und Reihenfolge änderbar) plus eigene; "Sonstiges" steht immer ganz unten.
function abteilungsListe() {
  const liste = [];
  ABTEILUNGEN_STANDARD.forEach(function (a, i) {
    const r = abteilungsListeRoh.get(a.id);
    liste.push({
      id: a.id, name: a.name, emoji: (r && r.emoji) || a.emoji, pos: r && typeof r.pos === "number" ? r.pos : (i + 1) * 10,
      eingebaut: true, fest: a.id === "sonstiges"
    });
  });
  abteilungsListeRoh.forEach(function (r) {
    if (r.eingebaut || r.geloescht || ABTEILUNGEN_STANDARD.some(function (a) { return a.id === r.id; })) return;
    liste.push({ id: r.id, name: r.name, emoji: r.emoji || "🛒", pos: typeof r.pos === "number" ? r.pos : 1000, eingebaut: false, fest: false });
  });
  const sonst = liste.filter(function (a) { return a.fest; });
  return liste.filter(function (a) { return !a.fest; })
    .sort(function (a, b) { return a.pos - b.pos || a.name.localeCompare(b.name, "de"); }).concat(sonst);
}

// Abteilung je Symbol aus ARTIKEL_SYMBOLE (alles, was dort nicht steht, landet in "Sonstiges").
const SYMBOL_ABTEILUNG = {
  obst: "🍎🍐🍌🍊🍋🍓🍇🍉🍒🍑🍍🥭🥝🍅🥒🫑🥕🌽🥔🧅🧄🍄🥬🥦🍆🥑🎃",
  fleisch: "🥩🍗🥓🐟🦐🌭",
  kuehl: "🥛🧈🧀🥚🍕🍟🍦🍔",
  back: "🍞🥖🥐🥨🍰",
  trocken: "🥜🥥🫒🍝🍚🌾🍫🍬🍯🥣🍪🍲",
  gewuerz: "🌶️🧂",
  getraenke: "💧🧃☕🍵🍺🍷🥂🥤"
};

// Zusätzliche Stichwörter, die ein Symbol-Stichwort übertrumpfen (z. B. "Olivenöl" gehört zu den Ölen, nicht zu den Oliven).
const ABTEILUNG_STICHWORTE = {
  obst: "kräuter petersilie schnittlauch koriander dill minze ingwer radieschen rucola zucchini sellerie fenchel salat rhabarber beere beeren",
  fleisch: "rind rinder schwein lamm gehacktes filet schnitzel salami aufschnitt bacon",
  kuehl: "mozzarella feta parmesan frischkäse schmand skyr kefir buttermilch tofu hummus gouda emmentaler mascarpone ricotta crème fraîche",
  back: "brötchen toastbrot knäckebrot kuchen",
  trocken: "linse linsen kichererbse kichererbsen bohne bohnen tomatenmark passata zucker backpulver hefe stärke couscous bulgur quinoa dose dosen konserve ketchup senf mayonnaise brühe tomaten-passata kokosmilch rosinen",
  gewuerz: "gewürz zimt curry kurkuma kümmel muskat paprikapulver oregano thymian rosmarin öl olivenöl rapsöl sonnenblumenöl essig sojasauce vanille lorbeer",
  getraenke: "getränk mineralwasser apfelsaft orangensaft schorle"
};

const ABTEILUNG_INDEX = (function () {
  const liste = [];
  Object.keys(SYMBOL_ABTEILUNG).forEach(function (abt) {
    Array.from(SYMBOL_ABTEILUNG[abt]).forEach(function (emoji) { SYMBOL_ABTEILUNG[emoji] = abt; });
  });
  ARTIKEL_SYMBOLE.forEach(function (eintrag) {
    const abt = SYMBOL_ABTEILUNG[eintrag[0]] || SYMBOL_ABTEILUNG[eintrag[0].replace("️", "")] || "sonstiges";
    eintrag[1].split(" ").forEach(function (wort) { liste.push([wort, abt, 0]); });
  });
  Object.keys(ABTEILUNG_STICHWORTE).forEach(function (abt) {
    ABTEILUNG_STICHWORTE[abt].split(" ").forEach(function (wort) { liste.push([wort, abt, 1]); });
  });
  return liste;
})();

function abteilungAutomatisch(name) {
  const woerter = String(name || "").toLowerCase().split(/[^a-zäöüßé]+/).filter(Boolean);
  let beste = "sonstiges", bestePunkte = 0;
  woerter.forEach(function (w) {
    ABTEILUNG_INDEX.forEach(function (k) {
      const schluessel = k[0];
      let punkte = 0;
      if (w === schluessel) punkte = 100 + schluessel.length;
      else if (schluessel.length >= 4 && w.endsWith(schluessel)) punkte = 50 + schluessel.length;
      else if (schluessel.length >= 4 && w.startsWith(schluessel)) punkte = 20 + schluessel.length;
      if (punkte > 0) punkte += k[2];
      if (punkte > bestePunkte) { bestePunkte = punkte; beste = k[1]; }
    });
  });
  return beste;
}

// Gleicher Name -> gleiche ID auf jedem Gerät, damit sich zwei Handys nicht in die Quere kommen.
function abteilungsId(name) {
  const text = String(name).trim().toLowerCase();
  function hash(seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return ((h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0"));
  }
  const hex = hash(1) + hash(2);
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

function abteilungFuer(name) {
  const w = abteilungsWahl.get(abteilungsId(name));
  if (w && !w.geloescht && abteilungsListe().some(function (a) { return a.id === w.abteilung; })) return w.abteilung;
  return abteilungAutomatisch(name);
}

async function abteilungSetzen(name, abteilung) {
  const id = abteilungsId(name);
  const alt = abteilungsWahl.get(id);
  const automatisch = abteilung === abteilungAutomatisch(name);
  if (!alt && automatisch) return;
  const eintrag = Object.assign({}, alt || {}, {
    id: id, name: name.trim(), abteilung: abteilung, geloescht: automatisch,
    aktualisiert: zeitNach(alt), dirty: 1
  });
  abteilungsWahl.set(id, eintrag);
  einkaufZeichnen();
  try {
    await transaktion(["abteilungen"], function (st) { st.abteilungen.put(eintrag); });
    await abteilungenNeuLaden();
    syncAnstossen();
  } catch (fehler) {
    alert("Das Speichern hat leider nicht geklappt.");
  }
}

const ABT_EMOJIS = ["🥦","🍎","🥩","🐟","🥛","🧀","🍞","🥫","🧂","🥤","🍷","🧊","🍦","🍫","🧻","🧴","🧼","🐾","🌿","🍽️","🛒","🏠","💊","🎁"];

async function abteilungListeSpeichern(eintraege) {
  eintraege.forEach(function (r) { abteilungsListeRoh.set(r.id, r); });
  einkaufZeichnen();
  try {
    await transaktion(["abteilungsliste"], function (st) { eintraege.forEach(function (r) { st.abteilungsliste.put(r); }); });
    await abteilungsListeNeuLaden();
    syncAnstossen();
  } catch (fehler) {
    alert("Das Speichern hat leider nicht geklappt.");
  }
}

// Schreibt Position (und ggf. Änderungen) für die Abteilungen: bestehender Datensatz + neue Werte.
function abteilungsDatensatz(a, aenderungen) {
  const alt = abteilungsListeRoh.get(a.id);
  return Object.assign({ id: a.id, name: a.name, emoji: a.emoji, pos: a.pos, eingebaut: !!a.eingebaut, geloescht: false }, alt || {}, aenderungen, {
    aktualisiert: zeitNach(alt), dirty: 1
  });
}

// Neue Reihenfolge speichern: alle bewegten Abteilungen bekommen fortlaufende Positionen.
async function abteilungVerschieben(id, richtung) {
  const liste = abteilungsListe().filter(function (a) { return !a.fest; });
  const i = liste.findIndex(function (a) { return a.id === id; });
  const j = i + richtung;
  if (i < 0 || j < 0 || j >= liste.length) return;
  const tausch = liste.slice(); tausch[i] = liste[j]; tausch[j] = liste[i];
  const geaendert = [];
  tausch.forEach(function (a, k) {
    const pos = (k + 1) * 10;
    if (a.pos !== pos || !abteilungsListeRoh.has(a.id)) geaendert.push(abteilungsDatensatz(a, { pos: pos }));
  });
  await abteilungListeSpeichern(geaendert);
}

async function abteilungAnlegen(name, emoji) {
  const n = name.trim();
  if (!n) return;
  if (abteilungsListe().some(function (a) { return a.name.toLowerCase() === n.toLowerCase(); })) { alert("Diese Abteilung gibt es schon."); return; }
  const liste = abteilungsListe().filter(function (a) { return !a.fest; });
  const pos = liste.length ? Math.max.apply(null, liste.map(function (a) { return a.pos; })) + 10 : 10;
  await abteilungListeSpeichern([{
    id: neueId(), name: n, emoji: emoji || "🛒", pos: pos, eingebaut: false, geloescht: false, aktualisiert: Date.now(), dirty: 1
  }]);
}

function abteilungenVerwalten(zurueck) {
  const box = el("div", { class: "abt-verw" });
  let offenId = null;
  const neuName = el("input", { type: "text", class: "eingabe", placeholder: "Name der neuen Abteilung", "aria-label": "Neue Abteilung", autocomplete: "off", autocapitalize: "sentences" });
  let neuEmoji = "🛒";
  const neuEmojiFeld = el("input", { type: "text", class: "eingabe abt-emoji-feld", value: neuEmoji, "aria-label": "Emoji", autocomplete: "off" });
  neuEmojiFeld.addEventListener("input", function () { neuEmoji = emojiNehmen(neuEmojiFeld.value) || "🛒"; });
  function emojiNehmen(text) {
    const t = text.trim();
    if (!t) return "";
    const teile = window.Intl && Intl.Segmenter
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)).map(function (x) { return x.segment; })
      : Array.from(t);
    return teile[teile.length - 1];
  }
  function chips(waehlen) {
    return el("div", { class: "abt-chips" }, ABT_EMOJIS.map(function (e) {
      return el("button", { class: "abt-chip", type: "button", text: e, "aria-label": "Emoji " + e, onclick: function () { waehlen(e); } });
    }));
  }
  function zeichnen() {
    const liste = abteilungsListe();
    const bewegbar = liste.filter(function (a) { return !a.fest; });
    const zeilen = liste.map(function (a) {
      const idx = bewegbar.findIndex(function (b) { return b.id === a.id; });
      const kopf = el("div", { class: "abt-zeile", "data-abt": a.id },
        el("button", {
          class: "abt-emoji-knopf", type: "button", text: a.emoji, "aria-label": "Emoji von " + a.name + " ändern",
          onclick: function () { offenId = offenId === a.id ? null : a.id; zeichnen(); }
        }),
        el("span", { class: "posten-name", text: a.name }),
        a.fest ? el("span", { class: "leise", text: "immer unten" }) : el("span", { class: "abt-aktionen" },
          el("button", { class: "abt-pfeil", type: "button", "aria-label": a.name + " nach oben", disabled: idx === 0, text: "↑", onclick: function () { abteilungVerschieben(a.id, -1); } }),
          el("button", { class: "abt-pfeil", type: "button", "aria-label": a.name + " nach unten", disabled: idx === bewegbar.length - 1, text: "↓", onclick: function () { abteilungVerschieben(a.id, 1); } }),
          a.eingebaut ? null : el("button", {
            class: "abt-pfeil", type: "button", "aria-label": a.name + " löschen", text: "✕",
            onclick: function () {
              if (confirm("Abteilung „" + a.name + "“ löschen? Die Artikel darin kommen wieder in ihre automatische Abteilung.")) {
                abteilungListeSpeichern([abteilungsDatensatz(a, { geloescht: true })]);
              }
            }
          })
        )
      );
      if (offenId !== a.id) return kopf;
      const feld = el("input", { type: "text", class: "eingabe abt-emoji-feld", value: a.emoji, "aria-label": "Emoji eingeben", autocomplete: "off" });
      feld.addEventListener("change", function () {
        const e = emojiNehmen(feld.value);
        if (e) abteilungListeSpeichern([abteilungsDatensatz(a, { emoji: e })]);
      });
      return el("div", { class: "abt-block" }, kopf,
        el("div", { class: "abt-editor" }, el("p", { class: "leise hinweis-klein", text: "Tippe ein Emoji ein oder wähle eins aus:" }), feld,
          chips(function (e) { abteilungListeSpeichern([abteilungsDatensatz(a, { emoji: e })]); })));
    });
    box.replaceChildren.apply(box, zeilen);
  }
  zeichnen();
  abteilungVerwaltenNeuzeichnen = zeichnen;
  const neuForm = el("form", {
    class: "abt-neu",
    onsubmit: function (e) {
      e.preventDefault();
      const n = neuName.value;
      neuName.value = ""; neuEmojiFeld.value = "🛒";
      const em = neuEmoji; neuEmoji = "🛒";
      abteilungAnlegen(n, em);
    }
  },
    el("h3", { class: "abschnitt", text: "Neue Abteilung" }),
    el("div", { class: "abt-neu-zeile" }, neuEmojiFeld, neuName,
      el("button", { class: "knopf knopf-primaer extra-plus", type: "submit", "aria-label": "Abteilung anlegen", text: "+" })),
    chips(function (e) { neuEmoji = e; neuEmojiFeld.value = e; })
  );
  function schliessen() { abteilungVerwaltenNeuzeichnen = null; if (zurueck) zurueck(); else blattSchliessen(); }
  blattZeigen({
    titel: "Abteilungen", links: { text: "Fertig", aktion: schliessen },
    inhalt: [el("p", { class: "leise", text: "Emoji antippen zum Ändern, mit ↑ ↓ die Reihenfolge anpassen. „Sonstiges“ bleibt immer unten." }), box, neuForm]
  });
}
let abteilungVerwaltenNeuzeichnen = null;

// Blatt zum langen Drücken auf einen Artikel: Abteilung wählen (und bei eigenen Artikeln entfernen).
function abteilungOeffnen(name, entfernen) {
  const aktuell = abteilungFuer(name);
  const knoepfe = abteilungsListe().map(function (a) {
    return el("button", {
      class: "abt-wahl" + (a.id === aktuell ? " aktiv" : ""), type: "button", "data-abt": a.id,
      onclick: function () { blattSchliessen(); abteilungSetzen(name, a.id); }
    },
      el("span", { class: "abt-emoji", text: a.emoji }),
      el("span", { class: "posten-name", text: a.name }),
      el("span", { class: "abt-haken", text: a.id === aktuell ? "✓" : "" })
    );
  });
  const inhalt = [el("p", { class: "leise", text: "In welche Abteilung gehört „" + name + "“? Das merkt sich die App für alle Wochen." })].concat(knoepfe);
  if (entfernen) {
    inhalt.push(el("button", {
      class: "knopf knopf-gefahr abt-entfernen", type: "button", text: "Von der Liste entfernen",
      onclick: function () { blattSchliessen(); entfernen(); }
    }));
  }
  blattZeigen({ titel: name, links: { text: "Schließen", aktion: blattSchliessen }, inhalt: inhalt });
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
// ---- "Neu von …": eigene Artikel, die die andere Person seit meinem letzten Blick auf die Liste ergänzt hat ----
function eigeneId() { return sbSitzung && sbSitzung.user && sbSitzung.user.id ? sbSitzung.user.id : ""; }
function eigenerName() {
  try { const n = (localStorage.getItem("essensplan-name") || "").trim(); if (n) return n; } catch (e) {}
  const mail = sbSitzung && sbSitzung.user && sbSitzung.user.email ? sbSitzung.user.email : "";
  const teil = mail.split("@")[0].replace(/[._-]+/g, " ").trim().split(" ")[0] || "";
  return teil ? teil.charAt(0).toUpperCase() + teil.slice(1) : "";
}
let einkaufGesehen = (function () {
  try {
    const w = Number(localStorage.getItem("essensplan-einkauf-gesehen"));
    if (w > 0) return w;
    localStorage.setItem("essensplan-einkauf-gesehen", String(Date.now()));
  } catch (e) {}
  return Date.now();
})();
function einkaufGesehenMerken() {
  einkaufGesehen = Date.now();
  try { localStorage.setItem("essensplan-einkauf-gesehen", String(einkaufGesehen)); } catch (e) {}
}
function extraIstNeu(e) {
  const ich = eigeneId();
  return !!(ich && e.vonId && e.vonId !== ich && e.erstellt > einkaufGesehen && !e.erledigt && !e.geloescht);
}
document.addEventListener("visibilitychange", function () {
  const k = document.querySelector("nav button.aktiv");
  if (document.visibilityState === "hidden" && k && k.dataset.ziel === "einkauf") einkaufGesehenMerken();
});

/* ---------- Vorrat: Zutaten, die immer da sind ---------- */

const VORRAT_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8"/><path d="M7.5 6.5h9"/><path d="M7 6.5c-1 .8-1.5 1.8-1.5 3v9a2.5 2.5 0 0 0 2.5 2.5h8a2.5 2.5 0 0 0 2.5-2.5v-9c0-1.2-.5-2.2-1.5-3"/><rect x="8.5" y="11" width="7" height="5" rx="1"/></svg>';

const ABTEILUNGEN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>';

function abteilungenIconKnoten() {
  const e = el("span", { class: "vorrat-icon" });
  e.innerHTML = ABTEILUNGEN_ICON;
  return e;
}

function vorratIconKnoten() {
  const e = el("span", { class: "vorrat-icon" });
  e.innerHTML = VORRAT_ICON;
  return e;
}

function vorratAktiv() {
  return Array.from(vorrat.values()).filter(function (v) { return !v.geloescht; })
    .sort(function (a, b) { return a.name.localeCompare(b.name, "de"); });
}

function vorratNamenSet() {
  return new Set(vorratAktiv().map(function (v) { return v.name.trim().toLowerCase(); }));
}

async function vorratSpeichern(eintraege) {
  eintraege.forEach(function (v) { vorrat.set(v.id, v); });
  einkaufZeichnen();
  vorratListeZeichnen();
  try {
    await transaktion(["vorrat"], function (st) { eintraege.forEach(function (v) { st.vorrat.put(v); }); });
    await vorratNeuLaden();
    syncAnstossen();
  } catch (fehler) {
    alert("Das Speichern hat leider nicht geklappt.");
  }
}

async function vorratHinzufuegen(nameText) {
  let name = nameText.trim();
  if (name === "") return;
  name = name.charAt(0).toUpperCase() + name.slice(1);
  const vorhanden = Array.from(vorrat.values()).find(function (v) { return v.name.trim().toLowerCase() === name.toLowerCase(); });
  if (vorhanden) {
    if (!vorhanden.geloescht) return;
    await vorratSpeichern([Object.assign({}, vorhanden, { name: name, geloescht: false, aktualisiert: zeitNach(vorhanden), dirty: 1 })]);
    return;
  }
  await vorratSpeichern([{ id: neueId(), name: name, geloescht: false, aktualisiert: Date.now(), dirty: 1 }]);
}

async function vorratEntfernen(id) {
  const v = vorrat.get(id);
  if (!v) return;
  await vorratSpeichern([Object.assign({}, v, { geloescht: true, aktualisiert: zeitNach(v), dirty: 1 })]);
}

let vorratListeKnoten = null;

function vorratListeZeichnen() {
  const box = vorratListeKnoten;
  if (!box || !document.body.contains(box)) return;
  const eintraege = vorratAktiv();
  if (eintraege.length === 0) {
    box.replaceChildren(el("p", { class: "leise", text: "Noch nichts im Vorrat." }));
    return;
  }
  box.replaceChildren.apply(box, eintraege.map(function (v) {
    return el("div", { class: "vorrat-zeile" },
      symbolKnoten(v.name),
      el("span", { class: "posten-name", text: v.name }),
      el("button", {
        class: "vorrat-x", type: "button", "aria-label": v.name + " aus dem Vorrat entfernen", text: "✕",
        onclick: function () { vorratEntfernen(v.id); }
      })
    );
  }));
}

function vorratOeffnen() {
  const feld = el("input", {
    type: "text", id: "vorrat-name", class: "eingabe", autocomplete: "off", autocapitalize: "sentences",
    placeholder: "Artikel, den du immer hast …", "aria-label": "Vorratsartikel"
  });
  const formular = el("form", {
    class: "vorrat-form",
    onsubmit: function (e) {
      e.preventDefault();
      const text = feld.value;
      feld.value = "";
      vorratHinzufuegen(text);
      feld.focus();
    }
  },
    feld,
    el("button", { class: "knopf knopf-primaer extra-plus", type: "submit", "aria-label": "Zum Vorrat hinzufügen", text: "+" })
  );
  vorratListeKnoten = el("div", { class: "vorrat-liste" });
  blattZeigen({
    titel: "Vorrat",
    links: { text: "Schließen", aktion: function () { blattSchliessen(); vorratListeKnoten = null; } },
    inhalt: [
      formular,
      vorratListeKnoten,
      el("p", { class: "leise hinweis-klein", text: "Diese Zutaten erscheinen nicht in der Einkaufsliste. Das gilt für jede Woche und auf beiden Handys." })
    ]
  });
  vorratListeZeichnen();
}

function extrasFuer(woche) {
  return Array.from(extras.values()).filter(function (e) { return e.woche === woche && !e.geloescht; })
    .sort(function (a, b) { return a.name.localeCompare(b.name, "de"); });
}

function einkaufZeichnen() {
  const box = document.getElementById("einkauf");
  const montag = angezeigteWoche;
  const woche = datumSchluessel(montag);
  const ergebnis = einkaufslisteBerechnen(montag);
  // Zutaten, die im Vorrat stehen, kommen nicht auf die Liste (eigene Artikel bleiben, die hat man bewusst eingetragen).
  const vorratNamen = vorratNamenSet();
  const ausgeblendet = [];
  ergebnis.posten = ergebnis.posten.filter(function (p) {
    if (!vorratNamen.has(p.name.trim().toLowerCase())) return true;
    if (ausgeblendet.indexOf(p.name) < 0) ausgeblendet.push(p.name);
    return false;
  });
  const abgehakt = abgehakteFuer(woche);
  const eigene = extrasFuer(woche);

  // Zutaten aus dem Wochenplan und eigene Artikel stehen in einer gemeinsamen Liste.
  const alle = ergebnis.posten.map(function (p) {
    return { name: p.name, quelle: "rezept", p: p, erledigt: abgehakt.has(p.schluessel), abt: abteilungFuer(p.name) };
  }).concat(eigene.map(function (e) {
    return { name: e.name, quelle: "eigen", e: e, erledigt: !!e.erledigt, abt: abteilungFuer(e.name) };
  })).sort(function (x, y) {
    return x.name.localeCompare(y.name, "de") || (x.quelle < y.quelle ? -1 : x.quelle > y.quelle ? 1 : 0);
  });
  const offen = alle.filter(function (x) { return !x.erledigt; });
  const erledigt = alle.filter(function (x) { return x.erledigt; });

  const hatteFokus = extraOffen && document.activeElement && document.activeElement.id === "extra-name";
  const kopfIcons = [
    { beschriftung: "Abteilungen", knoten: abteilungenIconKnoten(), aktion: function () { abteilungenVerwalten(null); } },
    { beschriftung: "Vorrat", knoten: vorratIconKnoten(), aktion: vorratOeffnen }
  ];
  if (offen.length > 0) {
    kopfIcons.push({
      beschriftung: "Liste teilen", knoten: teilenIconKnoten(),
      aktion: function () {
        einkaufTeilen(montag,
          offen.filter(function (x) { return x.quelle === "rezept"; }).map(function (x) { return x.p; }),
          offen.filter(function (x) { return x.quelle === "eigen"; }).map(function (x) { return x.e; }));
      }
    });
  }
  const teile = wochenKopf(kopfIcons);
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
  } else if (alle.length === 0 && ausgeblendet.length === 0) {
    teile.push(el("div", { class: "karte" },
      el("p", { text: "Die geplanten Gerichte haben keine Zutaten eingetragen." })
    ));
  } else {
    if (offen.length > 0) {
      abteilungsListe().forEach(function (a) {
        const gruppe = offen.filter(function (x) { return x.abt === a.id; });
        if (gruppe.length === 0) return;
        teile.push(el("h3", { class: "abschnitt abteilung", "data-abt": a.id },
          el("span", { text: a.emoji + " " + a.name }), el("span", { class: "abt-zahl", text: String(gruppe.length) })));
        teile.push(el("div", { class: "posten-liste" }, gruppe.map(zeile)));
      });
    } else {
      teile.push(el("p", { class: "leise", text: "Alles erledigt." }));
    }
    if (erledigt.length > 0) {
      teile.push(el("h3", { class: "abschnitt", text: "Erledigt" }));
      teile.push(el("div", { class: "posten-liste" }, erledigt.map(zeile)));
    }
  }
  if (alle.length > 0) {
    teile.push(el("p", { class: "leise hinweis-klein", text: "Gedrückt halten: Abteilung ändern" + (eigene.length > 0 ? " oder eigenen Artikel entfernen." : ".") }));
  }
  if (ausgeblendet.length > 0) {
    teile.push(el("details", { class: "vorrat-aus" },
      el("summary", { text: ausgeblendet.length + " Vorratsartikel ausgeblendet" }),
      el("p", { class: "leise", text: ausgeblendet.sort(function (a, b) { return a.localeCompare(b, "de"); }).join(", ") })
    ));
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

const EXTRA_EINHEITEN = ["Stück", "g", "kg", "ml", "l", "Packung", "Dose", "Glas", "Flasche", "Beutel", "Bund"];
let extraOffen = false; // Eingabe unter "Artikel hinzufügen" aufgeklappt?

// Eingabezeile für eigene Artikel (Name, optionale Menge) mit Vorschlägen aus früheren Einträgen.
function extraEingabe(woche) {
  const name = el("input", {
    type: "text", id: "extra-name", class: "eingabe", list: "extravorschlaege", autocomplete: "off",
    autocapitalize: "sentences", placeholder: "Artikel hinzufügen", "aria-label": "Artikel", value: extraEntwurf.name
  });
  const menge = el("input", {
    type: "text", id: "extra-menge", class: "eingabe extra-menge", autocomplete: "off", inputmode: "decimal",
    placeholder: "Menge", "aria-label": "Menge (optional)", value: extraEntwurf.menge
  });
  const einheit = el("select", { id: "extra-einheit", class: "eingabe extra-einheit", "aria-label": "Einheit" },
    EXTRA_EINHEITEN.map(function (e) { return el("option", { value: e, text: e }); }));
  einheit.value = EXTRA_EINHEITEN.indexOf(extraEntwurf.einheit) >= 0 ? extraEntwurf.einheit : "Stück";
  // Abteilung: schlägt beim Tippen die bekannte/automatische Abteilung vor; eine eigene Wahl bleibt bestehen.
  const abtWahl = el("select", { id: "extra-abt", class: "eingabe extra-abt", "aria-label": "Abteilung" },
    [el("option", { value: "", text: "Abteilung: automatisch" })].concat(abteilungsListe().map(function (a) {
      return el("option", { value: a.id, text: a.emoji + " " + a.name });
    })));
  function abtVorschlagen() {
    if (extraEntwurf.abt) { abtWahl.value = extraEntwurf.abt; return; }
    abtWahl.value = name.value.trim() ? abteilungFuer(name.value) : "";
  }
  abtVorschlagen();
  abtWahl.addEventListener("change", function () { extraEntwurf.abt = abtWahl.value; });
  name.addEventListener("input", function () { extraEntwurf.name = name.value; abtVorschlagen(); });
  menge.addEventListener("input", function () { extraEntwurf.menge = menge.value; });
  einheit.addEventListener("change", function () { extraEntwurf.einheit = einheit.value; });
  const formular = el("form", {
    class: "extra-form",
    hidden: !extraOffen,
    onsubmit: function (e) {
      e.preventDefault();
      // Ohne Zahl keine Einheit; sonst "2 Dose" (so wird es auch gespeichert und summiert).
      const zahl = menge.value.trim();
      extraHinzufuegen(woche, name.value, zahl ? zahl + " " + einheit.value : "", abtWahl.value);
    }
  },
    name, abtWahl, menge, einheit,
    el("button", { class: "knopf knopf-primaer extra-plus", type: "submit", "aria-label": "Zur Liste hinzufügen", text: "+" })
  );
  const kopf = el("button", { class: "import-kopf", type: "button", "aria-expanded": extraOffen ? "true" : "false" },
    el("span", { class: "import-titel", text: "+ Artikel hinzufügen" }),
    el("span", { class: "import-pfeil", text: "›" })
  );
  const huelle = el("div", { class: "karte import-karte extra-karte" + (extraOffen ? " offen" : "") }, kopf, formular);
  kopf.addEventListener("click", function () {
    extraOffen = !extraOffen;
    formular.hidden = !extraOffen;
    huelle.classList.toggle("offen", extraOffen);
    kopf.setAttribute("aria-expanded", extraOffen ? "true" : "false");
    if (extraOffen) name.focus();
  });
  return huelle;
}

function extraZeile(e) {
  const neu = extraIstNeu(e);
  const kachel = el("button", {
    class: "posten eigen" + (e.erledigt ? " erledigt" : "") + (neu ? " neu" : ""), type: "button", role: "checkbox",
    "aria-checked": e.erledigt ? "true" : "false",
    onclick: function () { extraUmschalten(e.id); }
  },
    el("span", { class: "haken", text: e.erledigt ? "✓" : "" }),
    symbolKnoten(e.name),
    el("span", { class: "posten-name", text: e.name }),
    el("span", { class: "posten-menge", text: e.menge || "" }),
    neu ? el("span", { class: "posten-neu", text: "NEU" }) : null,
    neu && e.von ? el("span", { class: "posten-von", text: "von " + e.von }) : null
  );
  // Langes Drücken: Abteilung ändern oder den eigenen Artikel entfernen.
  langDruck(kachel, function () {
    abteilungOeffnen(e.name, function () { extraLoeschen(e.id); });
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

async function extraHinzufuegen(woche, nameText, mengeText2, abteilung) {
  const name = nameText.trim();
  if (name === "") return;
  const menge = mengeText2.trim();
  extraEntwurf = { name: "", menge: "", einheit: extraEntwurf.einheit, abt: "" };
  // Gewählte Abteilung merken (weicht sie vom Vorschlag ab, gilt sie künftig für diesen Namen).
  if (abteilung && abteilung !== abteilungFuer(name)) await abteilungSetzen(name, abteilung);
  pushMeldungVormerken(name);
  // Gibt es den Artikel in dieser Woche schon, wird nichts doppelt angelegt.
  const vorhanden = Array.from(extras.values()).find(function (e) {
    return e.woche === woche && !e.geloescht && e.name.toLowerCase() === name.toLowerCase();
  });
  if (vorhanden) {
    // Noch offen: Mengen zusammenzählen. Schon abgehakt (also gekauft): neu auf die Liste, mit der neuen Menge.
    const neueMenge = vorhanden.erledigt ? (menge || vorhanden.menge) : extraMengenSummieren(vorhanden.menge || "", menge);
    await extraSpeichern([Object.assign({}, vorhanden, {
      erledigt: false, menge: neueMenge, erstellt: Date.now(), von: eigenerName(), vonId: eigeneId(),
      aktualisiert: zeitNach(vorhanden), dirty: 1
    })]);
    return;
  }
  await extraSpeichern([{
    id: neueId(), woche: woche, name: name, menge: menge, erledigt: false, geloescht: false,
    erstellt: Date.now(), von: eigenerName(), vonId: eigeneId(),
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
  const kachel = el("button", {
    class: "posten" + (erledigt ? " erledigt" : ""), type: "button", role: "checkbox",
    "aria-checked": erledigt ? "true" : "false",
    onclick: function () { postenUmschalten(montag, p.schluessel); }
  },
    el("span", { class: "haken", text: erledigt ? "✓" : "" }),
    symbolKnoten(p.name),
    el("span", { class: "posten-name", text: p.name }),
    el("span", { class: "posten-menge", text: mengeText(p) })
  );
  langDruck(kachel, function () { abteilungOeffnen(p.name, null); });
  return kachel;
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
// Logo (Teller, Gabel, Blatt) für das Kopfbild beim Plan-Teilen; Koordinaten wie im Logo, Ursprung bei 63/70.
const LOGO_RING = "M647.3 1687.9C649.4 1687.4 652.7 1685.5 654.7 1683.7C660.8 1678.3 661.8 1674.6 663.0 1653.9C663.5 1643.8 664.5 1629.7 665.2 1622.5C667.9 1594.4 664.7 1584.9 651.0 1580.0C649.1 1579.3 643.9 1577.4 639.5 1575.8C635.1 1574.2 628.6 1571.8 625.0 1570.5C621.4 1569.2 614.7 1566.5 610.0 1564.5C605.3 1562.4 599.5 1560.0 597.0 1559.0C584.9 1554.0 526.4 1523.3 514.3 1515.5C512.6 1514.4 509.2 1512.4 506.9 1511.0C497.3 1505.3 479.6 1493.1 465.1 1482.1C456.7 1475.7 448.5 1469.6 447.0 1468.5C432.2 1457.5 403.4 1431.7 382.6 1410.6C354.9 1382.7 336.6 1361.4 311.1 1327.6C305.2 1319.7 286.9 1292.2 277.5 1277.0C276.3 1275.1 273.7 1271.0 271.7 1267.9C269.7 1264.9 268.0 1262.0 268.0 1261.6C268.0 1261.2 267.2 1259.6 266.1 1258.2C262.4 1252.8 248.0 1224.0 238.5 1203.0C224.0 1170.7 223.0 1168.4 223.0 1167.1C223.0 1166.4 222.3 1164.5 221.3 1162.7C219.2 1158.6 214.9 1146.8 210.1 1131.5C200.3 1101.0 195.3 1080.9 187.9 1043.0C185.2 1029.0 182.3 1014.6 181.4 1011.1C180.6 1007.5 179.1 995.8 178.0 985.1C176.9 974.3 175.5 960.5 174.9 954.5C173.6 941.7 174.3 874.6 175.9 858.0C176.4 852.2 177.3 841.6 177.9 834.5C178.5 827.4 179.6 817.5 180.5 812.5C181.4 807.5 182.8 799.0 183.6 793.5C184.4 788.0 185.4 782.1 185.9 780.5C186.5 778.9 187.6 773.7 188.5 769.0C194.3 739.1 210.4 685.1 222.8 654.0C240.9 608.8 259.0 570.8 271.5 551.5C273.3 548.8 277.6 541.8 281.0 536.0C295.0 512.2 308.1 492.8 322.5 474.5C326.3 469.6 331.4 463.0 333.8 459.9C346.6 442.9 375.5 410.9 394.0 393.3C425.8 362.9 441.1 350.0 478.5 322.4C495.5 309.8 518.5 295.3 540.0 283.5C551.8 277.0 563.1 270.7 565.0 269.5C569.8 266.6 602.9 250.4 606.0 249.5C607.4 249.1 609.0 248.4 609.6 247.9C610.2 247.4 613.1 246.1 616.1 245.0C619.1 244.0 626.2 241.2 632.0 239.0C663.4 226.5 677.4 221.6 696.0 216.5C747.3 202.4 782.8 194.6 806.0 192.5C810.1 192.1 816.6 191.2 820.5 190.5C827.4 189.1 835.9 188.3 867.5 185.9C884.8 184.6 941.2 185.2 960.0 187.0C965.8 187.5 976.8 188.4 984.5 189.0C992.2 189.6 1002.1 190.7 1006.5 191.5C1010.9 192.2 1017.4 193.1 1021.0 193.5C1033.1 194.6 1073.3 202.9 1089.5 207.5C1113.9 214.4 1133.7 220.7 1152.5 227.5C1158.0 229.5 1165.0 232.0 1168.0 233.0C1171.0 234.0 1177.3 236.5 1182.0 238.5C1190.1 242.0 1193.6 243.5 1207.9 249.5C1221.5 255.2 1251.7 271.2 1283.0 289.5C1286.6 291.5 1291.1 294.1 1293.0 295.2C1303.6 301.3 1326.6 317.0 1343.5 329.7C1347.3 332.5 1352.5 336.4 1355.0 338.2C1360.0 341.8 1378.8 357.5 1392.0 368.9C1430.3 402.1 1476.3 453.3 1502.0 491.1C1517.2 513.6 1524.5 524.8 1529.1 533.0C1541.3 554.4 1544.9 555.2 1572.5 543.0C1579.7 539.9 1591.1 534.9 1598.0 532.0C1627.6 519.6 1632.0 516.7 1633.9 508.0C1635.6 500.4 1633.8 496.1 1618.0 469.0C1604.8 446.3 1592.7 429.4 1555.5 381.1C1523.3 339.2 1462.6 280.8 1409.6 240.6C1397.3 231.3 1352.4 201.1 1335.0 190.5C1333.1 189.3 1329.7 187.2 1327.5 185.8C1319.6 180.9 1290.3 165.1 1278.5 159.5C1271.9 156.4 1262.9 152.1 1258.5 150.0C1234.4 138.5 1214.7 129.8 1203.0 125.5C1199.4 124.2 1192.7 121.7 1188.0 119.9C1183.3 118.2 1176.1 115.7 1172.0 114.4C1167.9 113.2 1162.5 111.5 1160.0 110.6C1157.5 109.8 1150.8 107.7 1145.0 106.0C1139.2 104.3 1132.5 102.2 1130.0 101.4C1127.5 100.5 1121.3 98.8 1116.2 97.4C1111.1 96.1 1106.4 94.8 1105.9 94.4C1105.4 94.1 1101.0 93.0 1096.2 92.0C1091.4 91.0 1084.6 89.5 1081.0 88.6C1071.6 86.4 1044.0 81.3 1033.5 80.0C1028.5 79.3 1022.0 78.4 1019.0 77.9C1016.0 77.4 1006.8 76.3 998.5 75.5C990.2 74.7 977.4 73.3 970.0 72.3C950.6 69.8 867.4 69.8 849.5 72.3C842.9 73.2 831.9 74.4 825.0 75.0C818.1 75.5 809.1 76.5 805.0 77.1C773.0 81.7 757.7 84.4 742.5 88.2C738.1 89.3 731.4 90.8 727.5 91.6C723.6 92.3 717.4 93.8 713.5 94.9C709.6 96.1 702.9 97.9 698.5 99.0C694.1 100.2 687.4 101.9 683.5 102.9C672.1 105.9 628.6 120.7 601.5 130.8C594.1 133.6 572.5 142.9 568.9 144.9C568.1 145.4 559.5 149.4 549.9 153.8C518.5 168.3 497.4 179.7 471.0 196.5C469.1 197.7 462.6 201.8 456.5 205.6C370.8 259.0 295.4 328.5 232.4 412.5C220.0 429.0 184.0 483.3 184.0 485.5C184.0 485.7 181.9 489.4 179.4 493.7C176.8 498.0 173.6 503.5 172.2 506.0C170.9 508.5 168.6 512.5 167.2 515.0C156.5 534.1 128.9 591.6 126.5 600.0C126.1 601.4 125.4 603.0 124.9 603.6C124.4 604.2 123.1 607.1 122.1 610.1C121.0 613.1 118.5 619.8 116.5 625.0C106.1 652.4 92.7 694.8 88.5 713.5C87.6 717.4 86.1 723.2 85.1 726.5C84.1 729.8 82.9 735.4 82.5 739.0C82.1 742.6 80.9 748.0 80.0 751.1C79.0 754.2 77.7 760.9 77.1 766.0C76.4 771.1 75.1 779.4 74.0 784.4C73.0 789.4 71.6 798.2 71.0 804.0C70.4 809.8 69.2 818.5 68.4 823.5C64.2 849.6 62.9 950.5 66.4 984.0C68.3 1002.0 72.6 1033.0 75.0 1046.0C76.1 1051.8 77.7 1060.3 78.5 1065.0C81.3 1080.9 88.0 1108.6 91.6 1119.8C92.9 1123.8 94.0 1127.6 94.0 1128.2C94.0 1129.9 99.3 1146.9 104.2 1161.0C106.4 1167.3 109.3 1175.4 110.5 1179.0C111.8 1182.6 114.4 1189.5 116.3 1194.5C120.8 1205.8 124.6 1216.0 127.0 1222.8C128.1 1225.7 129.6 1229.3 130.4 1230.8C131.2 1232.3 135.3 1241.2 139.5 1250.5C143.8 1259.8 149.1 1271.1 151.5 1275.5C153.9 1279.9 157.6 1286.9 159.7 1291.0C165.7 1302.4 175.4 1319.2 186.7 1337.5C194.3 1349.9 217.6 1384.9 224.3 1394.0C227.4 1398.1 231.3 1403.5 233.2 1406.0C238.3 1413.0 251.7 1429.7 258.4 1437.5C272.6 1454.0 300.2 1483.2 313.0 1495.4C318.8 1500.9 326.4 1508.1 330.0 1511.5C352.9 1533.2 387.2 1560.7 420.5 1584.0C457.9 1610.2 542.8 1655.5 575.5 1666.8C577.1 1667.4 582.8 1669.5 588.0 1671.5C598.0 1675.3 634.1 1687.6 637.5 1688.3C641.0 1689.1 643.4 1689.0 647.3 1687.9Z";
const LOGO_GABEL = "M871.0 1764.8C887.5 1758.8 899.7 1748.9 910.5 1732.6C921.1 1716.5 924.4 1704.2 924.5 1680.0C924.5 1657.7 922.1 1565.8 921.0 1543.5C919.5 1516.0 918.2 1481.3 917.0 1440.0C916.5 1419.4 915.5 1392.8 915.0 1381.0C911.1 1296.9 909.4 1221.5 911.0 1201.9C914.3 1160.3 927.9 1134.1 958.9 1109.2C996.2 1079.4 1010.5 1065.5 1032.1 1038.0C1040.7 1027.1 1053.4 1005.0 1058.6 991.8C1063.2 980.2 1067.9 966.6 1069.0 961.5C1069.6 958.8 1070.9 953.6 1072.0 950.0C1078.8 927.4 1081.8 877.5 1079.0 833.5C1078.5 825.8 1077.4 805.5 1076.6 788.5C1074.5 746.3 1073.2 723.3 1071.5 699.0C1070.7 687.7 1069.6 667.7 1069.0 654.5C1068.4 641.3 1067.4 624.2 1066.9 616.5C1065.5 596.7 1064.1 571.8 1063.0 548.5C1062.5 537.5 1061.4 518.6 1060.5 506.5C1059.7 494.4 1058.3 467.4 1057.6 446.5C1056.4 409.2 1056.3 408.4 1053.8 402.8C1048.4 391.0 1039.0 384.9 1026.1 384.7C1014.1 384.5 1007.2 388.0 1000.3 397.9C995.7 404.5 995.3 407.8 995.1 451.0C995.1 471.1 994.8 494.5 994.5 503.0C993.5 531.1 992.0 679.3 991.9 746.0C991.9 783.3 991.4 813.1 990.9 815.2C989.5 820.7 982.9 828.4 977.3 831.1C966.8 836.2 955.6 834.4 946.8 826.2C937.8 817.8 938.3 823.1 937.1 727.9C936.5 682.0 935.6 621.3 935.0 593.0C934.5 564.7 933.8 510.9 933.5 473.5C932.9 405.5 932.9 405.5 930.0 399.5C921.2 381.6 898.7 378.4 884.0 393.1C875.6 401.5 876.0 397.6 875.5 481.6C875.3 522.2 874.7 572.6 874.2 593.5C873.6 614.4 873.1 672.0 873.0 721.5C872.9 771.1 872.5 813.2 872.1 815.3C870.7 821.3 864.8 828.3 858.1 831.8C843.9 839.4 827.7 833.4 820.6 818.1C818.1 812.6 817.9 802.6 816.0 560.5C814.8 406.5 814.8 406.5 811.9 400.3C800.9 377.2 767.7 379.3 760.4 403.5C759.5 406.6 759.0 424.1 758.5 468.6C758.2 502.1 757.5 545.2 756.9 564.5C755.2 628.3 754.0 688.8 753.5 747.0C753.2 778.6 752.7 806.8 752.4 809.5C749.3 837.9 712.9 844.2 700.5 818.5C697.7 812.7 697.8 819.1 696.0 555.5C694.8 388.7 695.7 402.6 685.5 392.4C680.5 387.3 678.6 386.1 674.0 385.0C657.3 380.9 643.6 386.9 636.5 401.4C633.9 406.7 633.7 408.3 632.9 424.8C630.7 476.0 628.9 512.1 628.0 526.0C627.0 541.1 626.2 553.9 624.0 596.0C623.4 607.3 622.5 622.8 622.0 630.5C621.4 638.2 620.3 658.0 619.5 674.5C618.7 691.0 617.3 714.0 616.5 725.5C613.5 768.2 611.0 822.4 610.1 866.0C609.0 914.9 612.9 945.2 624.0 976.0C625.7 980.7 627.9 986.8 628.9 989.6C630.9 995.0 640.4 1013.4 644.7 1020.4C646.2 1022.6 648.5 1026.3 649.8 1028.5C667.3 1056.4 686.9 1077.0 720.0 1102.0C741.2 1118.0 754.3 1133.4 762.7 1151.9C764.6 1156.1 766.8 1160.8 767.6 1162.4C768.4 1164.0 770.4 1170.3 772.0 1176.5C778.0 1199.5 778.1 1214.6 773.0 1327.0C771.8 1353.7 770.3 1394.8 769.0 1435.5C768.5 1452.5 767.6 1473.2 767.1 1481.5C766.1 1495.6 763.5 1565.6 762.6 1600.0C762.4 1608.5 761.6 1625.0 760.9 1636.5C760.2 1648.0 759.6 1667.6 759.6 1680.0C759.5 1702.5 759.5 1702.5 763.1 1713.0C771.8 1738.2 787.2 1754.5 811.0 1763.9C821.7 1768.1 828.5 1769.0 845.5 1768.6C860.8 1768.3 861.9 1768.1 871.0 1764.8Z";
const LOGO_BLATT = "M1052.5 1689.9C1057.4 1688.8 1065.5 1686.8 1070.5 1685.5C1075.5 1684.2 1081.3 1682.9 1083.5 1682.5C1089.8 1681.5 1118.0 1672.6 1137.5 1665.5C1143.0 1663.5 1150.0 1661.1 1153.0 1660.0C1167.6 1655.0 1186.2 1647.6 1190.6 1645.1C1191.6 1644.6 1197.0 1642.0 1202.5 1639.4C1242.3 1620.9 1254.9 1613.9 1294.4 1587.7C1333.2 1562.0 1335.2 1560.7 1340.8 1556.5C1342.2 1555.4 1353.1 1547.6 1365.0 1539.3C1386.3 1524.1 1393.6 1518.7 1409.4 1505.8C1413.9 1502.2 1426.6 1493.4 1437.6 1486.2C1460.1 1471.6 1463.3 1469.4 1482.6 1455.6C1498.8 1444.0 1499.6 1443.3 1518.4 1427.5C1562.4 1390.5 1589.2 1364.1 1621.0 1326.5C1625.7 1321.0 1630.0 1316.0 1630.6 1315.5C1639.3 1307.4 1682.8 1247.6 1698.9 1221.5C1709.4 1204.6 1721.2 1183.7 1731.7 1164.0C1734.2 1159.3 1737.3 1153.5 1738.6 1151.0C1742.3 1144.1 1754.5 1117.9 1758.6 1108.2C1760.6 1103.4 1763.3 1097.0 1764.7 1094.0C1766.0 1091.0 1768.7 1084.2 1770.6 1079.0C1772.5 1073.8 1775.2 1066.6 1776.5 1063.0C1783.8 1043.3 1797.2 999.2 1804.1 972.0C1805.3 967.3 1806.7 961.5 1807.2 959.0C1807.7 956.5 1809.3 949.8 1810.6 944.0C1811.9 938.2 1813.7 929.5 1814.5 924.5C1815.3 919.5 1816.4 913.9 1817.0 912.0C1817.5 910.1 1818.7 903.1 1819.6 896.5C1820.4 889.9 1821.5 882.7 1822.1 880.5C1822.6 878.3 1823.7 870.2 1824.5 862.5C1827.4 835.6 1827.9 831.5 1828.9 826.5C1829.8 821.6 1831.0 806.5 1833.1 772.0C1834.8 743.8 1835.3 703.1 1834.1 681.5C1833.5 670.5 1832.5 649.8 1831.9 635.5C1830.9 608.4 1828.0 581.3 1825.6 575.7C1824.9 574.0 1822.6 570.9 1820.6 569.0C1815.5 564.1 1806.6 564.1 1790.5 568.9C1784.5 570.7 1775.7 573.2 1771.0 574.5C1743.4 582.3 1727.8 587.0 1711.5 592.8C1675.9 605.2 1660.2 610.9 1645.5 616.6C1642.2 617.8 1635.8 620.2 1631.3 621.9C1626.8 623.5 1622.3 625.4 1621.3 625.9C1620.3 626.4 1615.7 628.5 1611.0 630.6C1587.7 640.6 1554.6 656.1 1540.5 663.6C1538.8 664.5 1533.2 667.5 1528.0 670.2C1522.8 673.0 1517.3 676.1 1515.8 677.1C1514.4 678.2 1513.0 679.0 1512.7 679.0C1510.4 679.0 1465.9 706.8 1451.0 717.5C1380.7 768.1 1329.9 820.4 1290.5 882.6C1269.2 916.4 1255.5 944.2 1241.9 981.0C1239.2 988.4 1236.4 995.9 1235.6 997.5C1234.9 999.1 1233.1 1004.5 1231.7 1009.5C1225.1 1032.2 1223.1 1039.9 1222.5 1044.5C1222.2 1047.2 1221.0 1052.7 1220.0 1056.5C1219.0 1060.3 1217.6 1067.3 1217.0 1072.0C1216.4 1076.6 1215.7 1080.7 1215.4 1081.1C1213.2 1084.8 1210.2 1115.4 1207.9 1159.0C1206.4 1187.9 1209.3 1244.6 1213.4 1266.0C1214.2 1270.1 1215.8 1279.6 1216.9 1287.0C1221.4 1316.4 1229.3 1349.2 1238.7 1377.2C1244.0 1392.7 1244.9 1394.7 1248.8 1398.7C1256.1 1405.9 1259.3 1405.6 1268.0 1396.5C1273.9 1390.5 1286.0 1375.5 1291.5 1367.3C1293.7 1364.1 1298.9 1356.8 1303.1 1351.0C1316.1 1332.9 1337.4 1301.8 1348.5 1284.5C1350.3 1281.8 1353.7 1276.3 1356.2 1272.5C1365.5 1258.1 1367.9 1254.0 1377.9 1236.0C1383.5 1225.8 1389.4 1215.2 1391.0 1212.5C1392.7 1209.8 1395.2 1205.5 1396.6 1203.0C1397.9 1200.5 1400.9 1195.6 1403.0 1192.0C1405.2 1188.4 1407.5 1184.4 1408.0 1183.1C1408.6 1181.8 1409.9 1179.6 1410.9 1178.1C1411.9 1176.7 1415.1 1171.0 1418.0 1165.5C1420.9 1160.0 1425.5 1151.2 1428.3 1146.0C1443.4 1117.5 1473.2 1072.5 1497.7 1041.0C1528.8 1001.2 1541.5 988.0 1548.7 988.0C1553.3 988.0 1555.4 991.3 1554.1 996.6C1552.3 1004.3 1547.7 1019.6 1546.5 1022.0C1545.8 1023.4 1544.5 1027.0 1543.7 1030.0C1542.8 1033.0 1540.5 1040.0 1538.5 1045.5C1536.5 1051.0 1533.8 1058.7 1532.5 1062.5C1531.2 1066.3 1528.2 1074.7 1526.0 1081.0C1523.7 1087.3 1521.4 1094.1 1520.9 1096.0C1519.9 1099.4 1516.4 1109.6 1510.9 1125.5C1509.4 1129.9 1506.5 1137.8 1504.5 1143.0C1502.5 1148.2 1499.8 1155.4 1498.5 1159.0C1495.7 1166.7 1490.7 1178.9 1489.2 1181.6C1488.0 1183.6 1483.6 1193.7 1475.4 1213.0C1463.7 1240.6 1434.9 1295.3 1415.8 1326.0C1411.6 1332.9 1407.1 1340.2 1405.8 1342.4C1400.7 1350.9 1386.0 1372.5 1378.6 1382.0C1375.9 1385.6 1372.3 1390.3 1370.6 1392.5C1344.4 1426.5 1318.0 1453.3 1286.0 1478.5C1279.1 1483.9 1271.7 1489.8 1269.5 1491.5C1264.9 1495.2 1243.9 1508.9 1234.0 1514.8C1214.6 1526.2 1171.1 1548.0 1167.6 1548.0C1167.2 1548.0 1165.4 1548.6 1163.7 1549.4C1161.9 1550.2 1155.5 1552.7 1149.5 1555.0C1143.5 1557.3 1136.0 1560.3 1132.9 1561.6C1129.8 1562.9 1126.8 1564.0 1126.2 1564.0C1125.6 1564.0 1121.6 1565.3 1117.3 1566.9C1097.9 1574.2 1070.1 1582.2 1044.0 1588.0C1033.4 1590.4 1025.9 1595.9 1024.0 1602.8C1022.9 1606.9 1022.8 1637.9 1023.8 1664.2C1024.6 1683.1 1025.1 1684.4 1035.0 1689.5C1040.6 1692.5 1041.3 1692.5 1052.5 1689.9Z";
const LOGO_X = 62.9, LOGO_Y = 69.8, LOGO_B = 1772.4, LOGO_H = 1699.2;

async function planBildErzeugen(montag) {
  const plan = plaene.get(datumSchluessel(montag));
  const sport = sportTage(plan);
  const stil = getComputedStyle(document.documentElement);
  const farbe = function (name, ersatz) { return stil.getPropertyValue(name).trim() || ersatz; };
  const BG = farbe("--bg", "#2a313c"), KARTE = farbe("--karte", "#323a47"), AKZENT = farbe("--akzent", "#f5b73c");
  const TEXT = farbe("--text", "#eef1f5"), LEISE = farbe("--text-leise", "#9aa5b5");
  const SPORT = farbe("--sport", "#4f9fe3"), AUF_SPORT = farbe("--auf-sport", "#ffffff");
  const SCHRIFT = '"Nunito", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  if (document.fonts && document.fonts.load) {
    try { await Promise.all(["400 30px Nunito", "700 40px Nunito", "800 52px Nunito"].map(function (f) { return document.fonts.load(f); })); } catch (e) { /* dann eben Systemschrift */ }
  }

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
  c.save();
  const ls = 66 / LOGO_B;
  c.translate(RAND, 142 - LOGO_H * ls); c.scale(ls, ls); c.translate(-LOGO_X, -LOGO_Y);
  c.fillStyle = AKZENT; c.fill(new Path2D(LOGO_RING), "evenodd"); c.fill(new Path2D(LOGO_GABEL), "evenodd");
  c.fillStyle = TEXT; c.fill(new Path2D(LOGO_BLATT), "evenodd");
  c.restore();
  c.font = "800 52px " + SCHRIFT;
  c.fillStyle = TEXT; c.textAlign = "left";
  c.fillText("Meal", RAND + 90, 134);
  const wMeal = c.measureText("Meal").width;
  c.fillStyle = AKZENT;
  c.fillText("Map", RAND + 90 + wMeal, 134);
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

const abteilungsListeNeuLaden = ladefunktion("abteilungsliste", function (liste) {
  abteilungsListeRoh = new Map(liste.map(function (r) { return [r.id, r]; }));
  if (abteilungVerwaltenNeuzeichnen && document.querySelector(".abt-verw")) abteilungVerwaltenNeuzeichnen();
  einkaufZeichnen();
});

const abteilungenNeuLaden = ladefunktion("abteilungen", function (liste) {
  abteilungsWahl = new Map(liste.map(function (a) { return [a.id, a]; }));
  einkaufZeichnen();
});

const vorratNeuLaden = ladefunktion("vorrat", function (liste) {
  vorrat = new Map(liste.map(function (v) { return [v.id, v]; }));
  vorratListeZeichnen();
  einkaufZeichnen();
});

async function alleNeuLaden() {
  await gerichteNeuLaden();
  await plaeneNeuLaden();
  await hakenNeuLaden();
  await extrasNeuLaden();
  await vorratNeuLaden();
  await abteilungenNeuLaden();
  await abteilungsListeNeuLaden();
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
        id: e.id, woche: e.woche,
        daten: { name: e.name, menge: e.menge || "", erstellt: e.erstellt || 0, von: e.von || "", vonId: e.vonId || "" },
        erledigt: !!e.erledigt, geloescht: !!e.geloescht, aktualisiert: e.aktualisiert
      };
    },
    vonServer: function (z) {
      const d = z.daten || {};
      return {
        id: z.id, woche: z.woche, name: d.name || "", menge: d.menge || "",
        erstellt: d.erstellt || 0, von: d.von || "", vonId: d.vonId || "",
        erledigt: !!z.erledigt, geloescht: !!z.geloescht, aktualisiert: z.aktualisiert
      };
    }
  },
  {
    name: "vorrat", speicher: "vorrat", konflikt: "id", block: 50,
    liste: function () { return Array.from(vorrat.values()); },
    holen: function (schluessel) { return vorrat.get(schluessel); },
    neuLaden: function () { return vorratNeuLaden(); },
    schluesselLokal: function (r) { return r.id; },
    schluesselServer: function (z) { return z.id; },
    zuServer: function (v) { return { id: v.id, daten: { name: v.name }, geloescht: !!v.geloescht, aktualisiert: v.aktualisiert }; },
    vonServer: function (z) {
      const d = z.daten || {};
      return { id: z.id, name: d.name || "", geloescht: !!z.geloescht, aktualisiert: z.aktualisiert };
    }
  },
  {
    name: "zutat_abteilung", speicher: "abteilungen", konflikt: "id", block: 50,
    liste: function () { return Array.from(abteilungsWahl.values()); },
    holen: function (schluessel) { return abteilungsWahl.get(schluessel); },
    neuLaden: function () { return abteilungenNeuLaden(); },
    schluesselLokal: function (r) { return r.id; },
    schluesselServer: function (z) { return z.id; },
    zuServer: function (a) { return { id: a.id, daten: { name: a.name, abteilung: a.abteilung }, geloescht: !!a.geloescht, aktualisiert: a.aktualisiert }; },
    vonServer: function (z) {
      const d = z.daten || {};
      return { id: z.id, name: d.name || "", abteilung: d.abteilung || "", geloescht: !!z.geloescht, aktualisiert: z.aktualisiert };
    }
  },
  {
    name: "abteilung_liste", speicher: "abteilungsliste", konflikt: "id", block: 50,
    liste: function () { return Array.from(abteilungsListeRoh.values()); },
    holen: function (schluessel) { return abteilungsListeRoh.get(schluessel); },
    neuLaden: function () { return abteilungsListeNeuLaden(); },
    schluesselLokal: function (r) { return r.id; },
    schluesselServer: function (z) { return z.id; },
    zuServer: function (r) {
      return { id: r.id, daten: { name: r.name, emoji: r.emoji, pos: r.pos, eingebaut: !!r.eingebaut }, geloescht: !!r.geloescht, aktualisiert: r.aktualisiert };
    },
    vonServer: function (z) {
      const d = z.daten || {};
      return { id: z.id, name: d.name || "", emoji: d.emoji || "", pos: typeof d.pos === "number" ? d.pos : 1000, eingebaut: !!d.eingebaut, geloescht: !!z.geloescht, aktualisiert: z.aktualisiert };
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
  { id: "nacht", name: "Night Pastel", art: "dunkel", meta: "#121212", farben: ["#121212", "#1c1c1c", "#f6f3a8", "#9dc3d4"] },
  { id: "dark", name: "Dark Beauty", art: "dunkel", meta: "#0b0d12", farben: ["#0b0d12", "#161a22", "#8fc4a0", "#f1f3f7"] }
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

/* ---------- Mitteilungen (Web-Push) ---------- */

const PUSH_OEFFENTLICH = "BBqOVH9t8dqqr-93XDK2IcbhE-1hnkgjM8MDiVWa0EhgUOA4jK4iM1ZCTEOZknyXvjLiwzROk4JQqWcVIpBSHqY";

function pushNameLesen() {
  try { return localStorage.getItem("essensplan-push-name") || ""; } catch (e) { return ""; }
}
function pushNameSpeichern(n) {
  try { localStorage.setItem("essensplan-push-name", n); } catch (e) {}
}

function pushSchluessel() {
  const t = PUSH_OEFFENTLICH.replace(/-/g, "+").replace(/_/g, "/");
  const roh = atob(t + "=".repeat((4 - t.length % 4) % 4));
  return Uint8Array.from(roh, function (c) { return c.charCodeAt(0); });
}

function pushUnterstuetzt() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function pushAbo() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function pushAktivieren(name) {
  const erlaubnis = await Notification.requestPermission();
  if (erlaubnis !== "granted") throw new Error("Mitteilungen sind nicht erlaubt. Du kannst das in den iPhone-Einstellungen unter Mitteilungen, MealMap ändern.");
  const reg = await navigator.serviceWorker.ready;
  let abo = await reg.pushManager.getSubscription();
  if (!abo) abo = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushSchluessel() });
  const j = abo.toJSON();
  const antwort = await sb.from("push_abos").upsert(
    { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, name: name },
    { onConflict: "user_id,endpoint" }
  );
  if (antwort.error) throw new Error("Das Speichern der Anmeldung hat nicht geklappt.");
  pushNameSpeichern(name);
}

async function pushDeaktivieren() {
  const abo = await pushAbo();
  if (!abo) return;
  const endpoint = abo.endpoint;
  await abo.unsubscribe();
  if (sb && sbSitzung) await sb.from("push_abos").delete().eq("endpoint", endpoint);
}

async function pushTest() {
  const antwort = await sb.functions.invoke("push-senden", { body: { test: true } });
  if (antwort.error) throw new Error("Der Test hat nicht geklappt. Ist der Schlüssel in Supabase eingetragen?");
  const d = antwort.data || {};
  if (!d.empfaenger) throw new Error("Dieses Handy ist noch nicht angemeldet.");
  if (!d.gesendet) throw new Error("Die Mitteilung wurde nicht zugestellt (" + (d.probleme || []).join(", ") + ").");
}

// Einstellungen: Bereich "Mitteilungen"
function pushBereichZeichnen(box) {
  function text(t) { return el("p", { class: "leise", style: "margin-top: 8px", text: t }); }
  function melden(t) { meldung.textContent = t; meldung.hidden = !t; }
  const meldung = el("p", { class: "leise", hidden: true });
  box.replaceChildren(el("p", { class: "leise", text: "Einen Moment …" }));
  (async function () {
    let teile;
    if (!pushUnterstuetzt()) {
      teile = [text("Mitteilungen gehen nur, wenn MealMap auf dem Home-Bildschirm liegt (Teilen-Menü, „Zum Home-Bildschirm“) und das iPhone iOS 16.4 oder neuer hat.")];
    } else if (!sb || !sbSitzung) {
      teile = [text("Bitte melde dich zuerst an (Wolken-Knopf oben). Danach kannst du Mitteilungen einschalten.")];
    } else {
      let abo = null;
      try { abo = await pushAbo(); } catch (e) {}
      const aktiv = !!abo && Notification.permission === "granted";
      const name = el("input", { type: "text", class: "eingabe", maxlength: "30", autocomplete: "off", autocapitalize: "words", placeholder: "Dein Name in der Mitteilung", value: pushNameLesen(), "aria-label": "Dein Name" });
      const haupt = el("button", { class: "knopf knopf-primaer", type: "button", style: "width: 100%; margin-top: 8px", text: aktiv ? "Namen speichern" : "Mitteilungen aktivieren" });
      haupt.addEventListener("click", async function () {
        const n = name.value.trim();
        if (!n) { melden("Bitte gib einen Namen ein, zum Beispiel deinen Vornamen."); return; }
        haupt.disabled = true; melden("");
        try { await pushAktivieren(n); pushBereichZeichnen(box); }
        catch (f) { melden(f.message); haupt.disabled = false; }
      });
      teile = [
        text(aktiv ? "Mitteilungen sind an. Du bekommst eine, wenn jemand anderes Artikel zur Einkaufsliste hinzufügt." : "Du bekommst eine Mitteilung, wenn jemand anderes Artikel zur Einkaufsliste hinzufügt. Das gilt nur für dieses Handy."),
        el("div", { style: "height: 8px" }), name, haupt
      ];
      if (aktiv) {
        const test = el("button", { class: "knopf knopf-sekundaer", type: "button", style: "width: 100%; margin-top: 8px", text: "Testmitteilung an mich" });
        test.addEventListener("click", async function () {
          test.disabled = true; melden("");
          try { await pushTest(); melden("Gesendet. Sie sollte gleich auf diesem Handy erscheinen."); }
          catch (f) { melden(f.message); }
          test.disabled = false;
        });
        const aus = el("button", { class: "knopf knopf-sekundaer", type: "button", style: "width: 100%; margin-top: 8px", text: "Mitteilungen ausschalten" });
        aus.addEventListener("click", async function () {
          aus.disabled = true;
          try { await pushDeaktivieren(); } catch (f) {}
          pushBereichZeichnen(box);
        });
        teile.push(test, aus);
      }
    }
    teile.push(meldung);
    box.replaceChildren.apply(box, teile);
  })();
}

// Merkt sich neu hinzugefügte Artikel und schickt nach kurzer Pause eine gemeinsame Mitteilung an die anderen Handys.
let pushWarteschlange = [];
let pushTimer = null;
function pushMeldungVormerken(name) {
  pushWarteschlange.push(name);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushWarteschlangeSenden, 15000);
}
async function pushWarteschlangeSenden() {
  clearTimeout(pushTimer);
  pushTimer = null;
  const namen = pushWarteschlange;
  pushWarteschlange = [];
  if (namen.length === 0 || !sb || !sbSitzung || navigator.onLine === false) return;
  try { await sb.functions.invoke("push-senden", { body: { anzahl: namen.length, namen: namen.slice(0, 20) } }); } catch (e) { /* Mitteilung ist nur ein Extra */ }
}
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "hidden" && pushWarteschlange.length > 0) pushWarteschlangeSenden();
});

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
  const pushBox = el("div");
  pushBereichZeichnen(pushBox);
  const nameFeld = el("input", { type: "text", class: "eingabe", id: "mein-name", autocomplete: "off", placeholder: "z. B. Philip", "aria-label": "Dein Name" });
  nameFeld.value = eigenerName();
  nameFeld.addEventListener("input", function () {
    try { localStorage.setItem("essensplan-name", nameFeld.value.trim()); } catch (e) {}
  });
  blattZeigen({
    titel: "Einstellungen",
    links: { text: "Schließen", aktion: blattSchliessen },
    inhalt: [
      el("h3", { class: "abschnitt", text: "Farbvariante" }),
      liste,
      el("p", { class: "leise", style: "margin-top: 16px", text: "Die Wahl gilt nur für dieses Gerät." }),
      el("h3", { class: "abschnitt", text: "Dein Name" }),
      nameFeld,
      el("p", { class: "leise", style: "margin-top: 8px", text: "Erscheint bei „neu von …“ in der Einkaufsliste, wenn du einen Artikel hinzufügst." }),
      el("h3", { class: "abschnitt", text: "Mitteilungen" }),
      pushBox
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
  // Tipp auf eine Mitteilung: zur Einkaufsliste springen.
  navigator.serviceWorker.addEventListener("message", function (e) {
    if (e.data && e.data.art === "zu-einkauf") {
      const k = document.querySelector("nav button[data-ziel=einkauf]");
      if (k && !k.classList.contains("aktiv")) k.click();
      if (typeof blattSchliessen === "function") blattSchliessen();
    }
  });
  window.addEventListener("load", function () {
    if (location.hash === "#einkauf") {
      const k = document.querySelector("nav button[data-ziel=einkauf]");
      if (k) k.click();
    }
    navigator.serviceWorker.register("sw.js").catch(function (fehler) {
      console.log("Service Worker konnte nicht registriert werden:", fehler);
    });
  });
}
