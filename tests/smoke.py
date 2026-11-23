"""Rauchtest für MealMap: startet die App lokal im Headless-Browser und prüft die wichtigsten Abläufe.

Aufruf (im Repo-Ordner):  python3 tests/smoke.py
Voraussetzung:            pip install playwright && playwright install chromium
Es wird nichts an Supabase gesendet: die App läuft ohne Anmeldung nur lokal.
"""
import datetime, functools, http.server, os, re, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8765

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()

def gericht(i, titel, portionen, zutaten, art=""):
    return {"id": f"id-{i}", "titel": titel, "bild": None, "portionen": portionen,
            "zutaten": [{"name": n, "menge": m, "einheit": e} for n, m, e in zutaten],
            "naehrwerte": {"kcal": 500, "eiweiss": 20, "kohlenhydrate": 50, "fett": 15},
            "notizen": "", "erstellt": 1, "geaendert": 1, "aktualisiert": 1, "geloescht": False, "dirty": 0,
            "khStufe": "", "ernaehrung": "", "art": art}

SEED = [
    gericht(0, "Spaghetti Bolognese", 4, [("Spaghetti", 400, "g"), ("Hackfleisch", 500, "g")]),
    gericht(1, "Gemüsecurry", 2, [("Kichererbsen", 1, "Dose"), ("Kokosmilch", 400, "ml"), ("Reis", 250, "g")]),
    gericht(2, "Haferkekse", 20, [("Haferflocken", 250, "g"), ("Eier", 2, "Stück")], art="Backen & Snacks"),
]
SEED[2]["portionenEinheit"] = "Stück"

SEED_JS = """async (seed) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('essensplan'); r.onsuccess = () => res(r.result); r.onerror = rej; });
  await new Promise(res => { const tx = db.transaction(['gerichte','wochenplan'], 'readwrite');
    seed.g.forEach(x => tx.objectStore('gerichte').put(x));
    tx.objectStore('wochenplan').put({woche: seed.w, tage: ['id-0','id-1',null,null,null], aktualisiert: 1, dirty: 0});
    tx.oncomplete = res; });
}"""

ergebnisse = []
def pruefe(name, bedingung):
    ergebnisse.append(bool(bedingung))
    print(("OK    " if bedingung else "FEHLER ") + name)

def schliesse_hinweise(pg):
    try: pg.click("text=Später", timeout=1500)
    except Exception: pass

# --- Versionen müssen zusammenpassen -------------------------------------------------
html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
sw = open(os.path.join(ROOT, "sw.js"), encoding="utf-8").read()
v_html = re.search(r"Version (\d+\.\d+)", html)
v_sw = re.search(r'VERSION = "essensplan-v(\d+)"', sw)
pruefe("Versionsangabe in index.html und sw.js vorhanden", v_html and v_sw)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
    ctx.add_init_script("localStorage.setItem('essensplan-ansicht','liste')")
    pg = ctx.new_page()
    fehler = []
    pg.on("pageerror", lambda e: fehler.append(str(e)))
    pg.clock.set_fixed_time(datetime.datetime(2026, 10, 19, 12, 0, 0))
    pg.goto(f"http://127.0.0.1:{PORT}/index.html"); pg.wait_for_timeout(800)
    pg.evaluate(SEED_JS, {"g": SEED, "w": "2026-10-19"}); pg.reload(); pg.wait_for_timeout(2500)
    schliesse_hinweise(pg)

    # Gerichteliste: Art-Filter
    pg.click("nav button[data-ziel=gerichte]"); pg.wait_for_timeout(400)
    pruefe("Art-Chips sichtbar (Alle + 2 Arten)", pg.locator("#gerichte .art-leiste .chip").count() == 3)
    pg.click("#gerichte .art-leiste .chip:has-text('Backen')"); pg.wait_for_timeout(300)
    pruefe("Filter 'Backen & Snacks' zeigt nur die Kekse",
           pg.locator("#gerichte").get_by_text("Haferkekse").count() >= 1 and pg.locator("#gerichte").get_by_text("Gemüsecurry").count() == 0)
    pg.click("#gerichte .art-leiste .chip:has-text('Alle')"); pg.wait_for_timeout(300)

    # Rezeptansicht: Einheit und Einkaufsliste
    pg.get_by_text("Haferkekse").first.click(); pg.wait_for_timeout(500)
    pruefe("Rezeptansicht: 'Für 20 Stück'", "Für 20 Stück" in pg.inner_text(".blatt"))
    pg.click("text=Zur Einkaufsliste"); pg.wait_for_timeout(400)
    pruefe("Zutatenblatt zeigt beide Zutaten", pg.locator(".auswahl-zeile").count() == 2)
    pg.click(".knopf-primaer:has-text('hinzufügen')"); pg.wait_for_timeout(900)
    pruefe("Wochenschlüssel der Artikel ist ein Text",
           pg.evaluate("Array.from(extras.values()).every(e => typeof e.woche === 'string')"))
    pg.click("nav button[data-ziel=einkauf]"); pg.wait_for_timeout(500)
    liste = pg.inner_text("#einkauf")
    pruefe("Einkaufsliste enthält Kekszutaten und Wochenplan-Zutaten",
           "Haferflocken" in liste and "Eier" in liste and "Spaghetti" in liste)

    # Wochenplan-Auswahl blendet Snacks standardmäßig aus
    pg.click("nav button[data-ziel=wochenplan]"); pg.wait_for_timeout(400)
    pg.evaluate("gerichtWaehlen(2, null)"); pg.wait_for_timeout(500)
    pruefe("Wochenplan-Auswahl: Snack zunächst versteckt", pg.locator(".blatt .waehl-zeile").get_by_text("Haferkekse").count() == 0)
    pg.click(".blatt .chip:has-text('Alle anzeigen')"); pg.wait_for_timeout(300)
    pruefe("Wochenplan-Auswahl: 'Alle anzeigen' zeigt Snack", pg.locator(".blatt .waehl-zeile").get_by_text("Haferkekse").count() >= 1)

    pruefe("Keine JavaScript-Fehler", not fehler)
    if fehler: print(fehler)
    b.close()

srv.shutdown()
print(f"\n{sum(ergebnisse)} von {len(ergebnisse)} Prüfungen bestanden")
sys.exit(0 if all(ergebnisse) else 1)
