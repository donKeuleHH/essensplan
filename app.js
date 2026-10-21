"use strict";

/* =====================================================================
   Essensplan
   Alle Daten liegen zuerst auf dem Gerät (IndexedDB), die App funktioniert
   also auch offline. Ist in config.js ein Supabase-Projekt eingetragen und
   man angemeldet, werden die Daten zusätzlich mit den anderen Geräten abgeglichen.
   ===================================================================== */

const EINHEITEN = ["g", "kg", "ml", "l", "Stück", "EL", "TL", "Packung"];

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
let khFilterListe = "";

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

function navigationEinrichten() {
  const reiter = document.querySelectorAll("nav button");
  const ansichten = document.querySelectorAll(".ansicht");
  const titel = document.getElementById("titel");
  reiter.forEach(function (knopf) {
    knopf.addEventListener("click", function () {
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
    teile.push(khChips(khFilterListe, function (w) { khFilterListe = w; listeZeichnen(); }));
    const sichtbar = sortiert.filter(function (g) { return !khFilterListe || g.khStufe === khFilterListe; });
    if (sichtbar.length === 0) {
      teile.push(el("p", { class: "leise", text: "Kein Gericht mit dieser Angabe. Die Stufe stellst du beim Bearbeiten eines Gerichts ein." }));
    }
    sichtbar.forEach(function (g) {
      teile.push(wischZeile(gerichtKarte(g), "Löschen", function () { gerichtLoeschen(g); }));
    });
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
    : el("div", { class: "thumb platzhalter", text: "🍽️" });

  const meta = [zahlText(g.portionen) + " " + pluralPortionen(g.portionen)];
  if (g.naehrwerte && g.naehrwerte.kcal !== null && g.naehrwerte.kcal !== undefined) {
    meta.push(zahlText(g.naehrwerte.kcal) + " kcal");
  }
  meta.push(g.zutaten.length + (g.zutaten.length === 1 ? " Zutat" : " Zutaten"));
  if (KH_TEXT[g.khStufe]) meta.push(KH_TEXT[g.khStufe]);

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
    KH_TEXT[g.khStufe] ? el("span", { class: "status", text: KH_TEXT[g.khStufe] }) : null,
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
      el("label", { class: "feld" }, el("span", { text: "Titel" }), titelFeld),
      el("div", { class: "feld" }, el("span", { text: "Foto (optional)" }), bildBereich, dateiFeld),
      el("label", { class: "feld" }, el("span", { text: "Anzahl Portionen (Mengen rechnen sich automatisch um)" }), portionenFeld),
      el("label", { class: "feld" }, el("span", { text: "Kohlenhydrate (für den Filter bei Sport- und Ruhetagen)" }), khStufeFeld),
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
  if (neu) titelFeld.focus();
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
  if (datumSchluessel(montag) !== datumSchluessel(standard)) {
    teile.push(el("button", {
      class: "textknopf zurueck", type: "button",
      onclick: function () { angezeigteWoche = standardWoche(); wochenAnsichtenZeichnen(); },
      text: "Zu KW " + kalenderwoche(standard)
    }));
  }
  return teile;
}

function kurzInfo(g) {
  const teile = [zahlText(g.portionen) + " " + pluralPortionen(g.portionen)];
  if (g.naehrwerte && g.naehrwerte.kcal !== null && g.naehrwerte.kcal !== undefined) {
    teile.push(zahlText(g.naehrwerte.kcal) + " kcal");
  }
  if (KH_TEXT[g.khStufe]) teile.push(KH_TEXT[g.khStufe]);
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
    teile.push(tagKarte(i, tag, g || null, datumSchluessel(tag) === heute, sportTage(plan)[i]));
  }
  box.replaceChildren.apply(box, teile);
}

function tagKarte(index, tag, g, istHeute, istSport) {
  let inhalt;
  if (g) {
    inhalt = [
      g.bild
        ? el("img", { class: "thumb klein", src: g.bild, alt: "", loading: "lazy" })
        : el("div", { class: "thumb klein platzhalter", text: "🍽️" }),
      el("div", { class: "gericht-info" }, el("h3", { text: g.titel }), el("p", { text: kurzInfo(g) }))
    ];
  } else {
    inhalt = [el("span", { class: "tag-leer", text: "＋ Gericht wählen" })];
  }
  const karte = el("button", {
    class: "tag" + (istHeute ? " heute" : ""), type: "button", "aria-label": TAGNAMEN[index],
    onclick: function () { gerichtWaehlen(index, g ? g.id : null); }
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
  if (!g) return karte;
  return wischZeile(karte, "Entfernen", function () { tagSetzen(angezeigteWoche, index, null); });
}

// Zeigt die Gerichte zur Auswahl für einen Tag der gerade angezeigten Woche.
function gerichtWaehlen(index, aktuelleId) {
  const montag = angezeigteWoche;
  const tag = tagVerschieben(montag, index);
  const suche = el("input", {
    type: "search", class: "eingabe", autocomplete: "off", autocapitalize: "off", placeholder: "Gericht suchen …"
  });
  const liste = el("div", { style: "margin-top: 14px" });
  let khAuswahl = "";
  const chips = khChips("", function (w) { khAuswahl = w; listeZeichnen2(); });

  function listeZeichnen2() {
    const q = suche.value.trim().toLowerCase();
    const treffer = gerichte
      .filter(function (g) { return g.titel.toLowerCase().indexOf(q) >= 0 && (!khAuswahl || g.khStufe === khAuswahl); })
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
  suche.addEventListener("input", listeZeichnen2);
  listeZeichnen2();

  blattZeigen({
    titel: TAGNAMEN[index] + ", " + kurzDatum(tag),
    links: { text: "Abbrechen", aktion: blattSchliessen },
    inhalt: [
      gerichte.length > 0 ? suche : null,
      gerichte.length > 0 ? chips : null,
      liste,
      aktuelleId !== null && aktuelleId !== undefined
        ? el("button", {
            class: "knopf knopf-gefahr", type: "button", style: "width: 100%; margin-top: 8px",
            onclick: function () { tagSetzen(montag, index, null); },
            text: "Gericht für diesen Tag entfernen"
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
          notizen: g.notizen, erstellt: g.erstellt, geaendert: g.geaendert, khStufe: g.khStufe || ""
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
        zutaten: d.zutaten || [], naehrwerte: d.naehrwerte || {}, notizen: d.notizen || "", khStufe: d.khStufe || "",
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
  { id: "sturm", name: "Stormy morning", art: "dunkel", meta: "#2e3c4a", farben: ["#2e3c4a", "#384959", "#88bdf2", "#ebf3fb"] }
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

start();

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
