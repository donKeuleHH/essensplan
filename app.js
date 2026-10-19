"use strict";

/* =====================================================================
   Essensplan – Sprint 2: Gerichte anlegen, ansehen, bearbeiten, löschen
   Alle Daten liegen auf dem Gerät (IndexedDB), es wird nichts verschickt.
   ===================================================================== */

const EINHEITEN = ["g", "kg", "ml", "l", "Stück", "EL", "TL", "Packung"];

/* ---------- Datenbank ---------- */

let db = null;

function datenbankOeffnen() {
  return new Promise(function (resolve, reject) {
    const anfrage = indexedDB.open("essensplan", 3);
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

let gerichte = [];
let plaene = new Map(); // Wochenpläne: Schlüssel = Datum des Montags, z. B. "2026-10-19"
let einkaufStatus = new Map(); // abgehakte Posten der Einkaufsliste, je Woche

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
  try {
    await schreiben("gerichte", function (s) { return s.delete(g.id); });
    await alleNeuLaden();
    blattSchliessen();
  } catch (fehler) {
    alert("Das Löschen hat leider nicht geklappt.");
  }
}

/* ---------- Formular: Gericht anlegen / bearbeiten ---------- */

// Verkleinert ein Foto auf max. 900 Pixel Kantenlänge, damit der Speicher nicht vollläuft.
function bildVerkleinern(datei) {
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(datei);
    const bild = new Image();
    bild.onload = function () {
      const faktor = Math.min(1, 900 / Math.max(bild.naturalWidth, bild.naturalHeight));
      const breite = Math.max(1, Math.round(bild.naturalWidth * faktor));
      const hoehe = Math.max(1, Math.round(bild.naturalHeight * faktor));
      const leinwand = document.createElement("canvas");
      leinwand.width = breite;
      leinwand.height = hoehe;
      leinwand.getContext("2d").drawImage(bild, 0, 0, breite, hoehe);
      URL.revokeObjectURL(url);
      resolve(leinwand.toDataURL("image/jpeg", 0.8));
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

    const datensatz = {
      titel: titel,
      bild: bild,
      portionen: portionen,
      zutaten: zutaten,
      naehrwerte: werte,
      notizen: notizenFeld.value.trim(),
      erstellt: g.erstellt || Date.now(),
      geaendert: Date.now()
    };
    if (g.id !== undefined) datensatz.id = g.id;

    speichertGerade = true;
    try {
      const id = await schreiben("gerichte", function (s) { return s.put(datensatz); });
      await alleNeuLaden();
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
  const plan = { woche: schluessel, tage: alt ? alt.tage.slice() : [null, null, null, null, null] };
  plan.tage[index] = gerichtId;
  try {
    await schreiben("wochenplan", function (s) { return s.put(plan); });
    plaene.set(schluessel, plan);
    blattSchliessen();
    wochenAnsichtenZeichnen();
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
  const status = einkaufStatus.get(datumSchluessel(montag));
  const abgehakt = new Set(status ? status.abgehakt : []);
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

async function einkaufSpeichern(eintrag) {
  einkaufStatus.set(eintrag.woche, eintrag);
  einkaufZeichnen(); // sofort anzeigen, dann speichern
  try {
    await schreiben("einkauf", function (s) { return s.put(eintrag); });
  } catch (fehler) {
    alert("Das Speichern hat leider nicht geklappt.");
  }
}

async function postenUmschalten(montag, schluessel) {
  const woche = datumSchluessel(montag);
  const alt = einkaufStatus.get(woche);
  const menge = new Set(alt ? alt.abgehakt : []);
  if (menge.has(schluessel)) menge.delete(schluessel); else menge.add(schluessel);
  await einkaufSpeichern({ woche: woche, abgehakt: Array.from(menge) });
}

async function hakenZuruecksetzen(montag) {
  await einkaufSpeichern({ woche: datumSchluessel(montag), abgehakt: [] });
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

async function alleNeuLaden() {
  gerichte = await gerichteLaden();
  plaene = new Map((await alleLesen("wochenplan")).map(function (p) { return [p.woche, p]; }));
  einkaufStatus = new Map((await alleLesen("einkauf")).map(function (e) { return [e.woche, e]; }));
  listeZeichnen();
  wochenAnsichtenZeichnen();
  vorschlaegeAktualisieren();
}

/* ---------- Start ---------- */

async function start() {
  navigationEinrichten();
  try {
    db = await datenbankOeffnen();
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
