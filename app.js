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
    const anfrage = indexedDB.open("essensplan", 4);
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

/* ---------- Zustand ---------- */

let gerichteRoh = new Map(); // alle Gerichte inkl. gelöschter (der Löschmarker wird mit abgeglichen)
let gerichte = [];           // nur die sichtbaren Gerichte
let plaene = new Map();      // Wochenpläne: Schlüssel = Datum des Montags, z. B. "2026-10-19"
let haken = new Map();       // abgehakte Einkaufsposten: Schlüssel = "Woche|Posten"

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
    sortiert.forEach(function (g) { teile.push(gerichtKarte(g)); });
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

  const inhalt = [
    g.bild ? el("img", { class: "detail-bild", src: g.bild, alt: g.titel }) : null,
    el("h1", { class: "detail-titel", text: g.titel }),
    el("p", { class: "leise", text: "Für " + zahlText(g.portionen) + " " + pluralPortionen(g.portionen) })
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
    inhalt.push(el("ul", { class: "zutatenliste" }, g.zutaten.map(function (z) {
      const menge = z.menge === null || z.menge === undefined ? "" : zahlText(z.menge) + " " + z.einheit;
      return el("li", {}, el("span", { text: z.name }), el("span", { text: menge }));
    })));
  }

  if (g.notizen) {
    inhalt.push(el("h3", { class: "abschnitt", text: "Notizen" }));
    inhalt.push(el("p", { class: "notizen", text: g.notizen }));
  }

  inhalt.push(el("div", { class: "reihe", style: "margin-top: 28px" },
    el("button", { class: "knopf knopf-primaer", type: "button", onclick: function () { formularOeffnen(g); }, text: "Bearbeiten" }),
    el("button", { class: "knopf knopf-gefahr", type: "button", onclick: function () { gerichtLoeschen(g); }, text: "Löschen" })
  ));

  blattZeigen({
    titel: "Gericht",
    links: { text: "Schließen", aktion: blattSchliessen },
    inhalt: inhalt
  });
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
  const neu = !gericht;
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
      el("label", { class: "feld" }, el("span", { text: "Anzahl Portionen" }), portionenFeld),
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
    teile.push(tagKarte(i, tag, g || null, datumSchluessel(tag) === heute));
  }
  box.replaceChildren.apply(box, teile);
}

function tagKarte(index, tag, g, istHeute) {
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
  return el("button", {
    class: "tag" + (istHeute ? " heute" : ""), type: "button", "aria-label": TAGNAMEN[index],
    onclick: function () { gerichtWaehlen(index, g ? g.id : null); }
  },
    el("div", { class: "tag-datum" },
      el("div", { class: "name", text: TAGKURZ[index] }),
      el("div", { class: "datum", text: kurzDatum(tag) })
    ),
    el("div", { class: "tag-inhalt" }, inhalt)
  );
}

// Zeigt die Gerichte zur Auswahl für einen Tag der gerade angezeigten Woche.
function gerichtWaehlen(index, aktuelleId) {
  const montag = angezeigteWoche;
  const tag = tagVerschieben(montag, index);
  const suche = el("input", {
    type: "search", class: "eingabe", autocomplete: "off", autocapitalize: "off", placeholder: "Gericht suchen …"
  });
  const liste = el("div", { style: "margin-top: 14px" });

  function listeZeichnen2() {
    const q = suche.value.trim().toLowerCase();
    const treffer = gerichte
      .filter(function (g) { return g.titel.toLowerCase().indexOf(q) >= 0; })
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

async function tagSetzen(montag, index, gerichtId) {
  const schluessel = datumSchluessel(montag);
  const alt = plaene.get(schluessel);
  const plan = {
    woche: schluessel,
    tage: alt ? alt.tage.slice() : [null, null, null, null, null],
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

function einkaufZeichnen() {
  const box = document.getElementById("einkauf");
  const montag = angezeigteWoche;
  const ergebnis = einkaufslisteBerechnen(montag);
  const abgehakt = abgehakteFuer(datumSchluessel(montag));
  const teile = wochenKopf();

  if (ergebnis.anzahlGerichte === 0) {
    teile.push(el("div", { class: "karte leer" },
      el("div", { class: "leer-symbol", text: "🛒" }),
      el("h2", { text: "Noch nichts zu kaufen" }),
      el("p", { text: "Für diese Woche ist noch kein Gericht geplant. Wähle sie im Reiter „Wochenplan“ aus." })
    ));
  } else if (ergebnis.posten.length === 0) {
    teile.push(el("div", { class: "karte" },
      el("p", { text: "Die geplanten Gerichte haben keine Zutaten eingetragen." })
    ));
  } else {
    const offen = ergebnis.posten.filter(function (p) { return !abgehakt.has(p.schluessel); });
    const erledigt = ergebnis.posten.filter(function (p) { return abgehakt.has(p.schluessel); });

    teile.push(el("p", {
      class: "leise einkauf-info",
      text: "Aus " + ergebnis.anzahlGerichte + (ergebnis.anzahlGerichte === 1 ? " geplantem Gericht" : " geplanten Gerichten") +
        " · " + erledigt.length + " von " + ergebnis.posten.length + " erledigt"
    }));

    const knoepfe = [];
    if (offen.length > 0) {
      knoepfe.push(el("button", { class: "knopf knopf-sekundaer", type: "button", onclick: function () { einkaufTeilen(montag, offen); }, text: "Liste teilen" }));
    }
    if (erledigt.length > 0) {
      knoepfe.push(el("button", { class: "knopf knopf-sekundaer", type: "button", onclick: function () { hakenZuruecksetzen(montag); }, text: "Haken entfernen" }));
    }
    if (knoepfe.length > 0) teile.push(el("div", { class: "reihe" }, knoepfe));

    if (offen.length > 0) {
      teile.push(el("div", { class: "posten-liste" }, offen.map(function (p) { return postenZeile(p, false, montag); })));
    } else {
      teile.push(el("p", { class: "leise", text: "Alles erledigt." }));
    }
    if (erledigt.length > 0) {
      teile.push(el("h3", { class: "abschnitt", text: "Erledigt" }));
      teile.push(el("div", { class: "posten-liste" }, erledigt.map(function (p) { return postenZeile(p, true, montag); })));
    }
  }
  box.replaceChildren.apply(box, teile);
}

function postenZeile(p, erledigt, montag) {
  return el("button", {
    class: "posten" + (erledigt ? " erledigt" : ""), type: "button", role: "checkbox",
    "aria-checked": erledigt ? "true" : "false",
    onclick: function () { postenUmschalten(montag, p.schluessel); }
  },
    el("span", { class: "haken", text: erledigt ? "✓" : "" }),
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
  if (neue.length > 0) await hakenSpeichern(neue);
}

// Öffnet das iPhone-Teilen-Menü (Nachrichten, WhatsApp, Notizen …) mit den offenen Posten.
async function einkaufTeilen(montag, offene) {
  const freitag = tagVerschieben(montag, 4);
  const zeilen = offene.map(function (p) {
    const menge = mengeText(p);
    return "• " + (menge ? menge + " " : "") + p.name;
  });
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

async function alleNeuLaden() {
  await gerichteNeuLaden();
  await plaeneNeuLaden();
  await hakenNeuLaden();
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
          notizen: g.notizen, erstellt: g.erstellt, geaendert: g.geaendert
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
        zutaten: d.zutaten || [], naehrwerte: d.naehrwerte || {}, notizen: d.notizen || "",
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
    zuServer: function (p) { return { woche: p.woche, tage: p.tage, aktualisiert: p.aktualisiert }; },
    vonServer: function (z) { return { woche: z.woche, tage: z.tage, aktualisiert: z.aktualisiert }; }
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

async function start() {
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
