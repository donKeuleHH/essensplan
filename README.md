# MealMap

Privater Wochenplaner für Gerichte und Einkaufsliste (PWA). Läuft auf GitHub Pages, Anmeldung und Abgleich über Supabase.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Grundgerüst, Startbilder für iOS, Versionszeile (`Version x.y`) |
| `app.js` | gesamte Logik: Gerichte, Wochenplan, Einkaufsliste, Vorrat, Sync |
| `style.css` | alle Stile inkl. Farbvarianten |
| `sw.js` | Service Worker (Offline, Update-Prüfung), Konstante `VERSION` |
| `supabase.js`, `config.js` | Supabase-Client und Projektadresse mit öffentlichem Schlüssel |
| `manifest.webmanifest`, `app-icon-*`, `startbilder/` | Installation auf dem Homescreen |
| `tests/smoke.py` | Rauchtest im Headless-Browser |

Lokale Daten liegen in IndexedDB (`essensplan`), der Abgleich mit Supabase läuft lokal-zuerst (neueres `aktualisiert` gewinnt, Löschen als Markierung `geloescht`).
Rezeptdaten wie Art oder Mengeneinheit stehen im JSON-Feld `daten` der Tabelle `gerichte`, dafür sind keine neuen Spalten nötig.

## Release-Ablauf

1. Änderung machen und `python3 tests/smoke.py` ausführen (alles muss OK sein).
2. `VERSION` in `sw.js` um eins erhöhen und die Zahl in `index.html` (`Version x.y`) anheben.
3. Auf `main` pushen, GitHub Pages veröffentlicht automatisch.
4. In der App ganz schließen und zweimal öffnen, unter Einstellungen → „Über die App“ steht dann die neue Version.

## Test

Voraussetzung: `pip install playwright` und `playwright install chromium`.
Der Test startet einen lokalen Webserver, legt Beispielgerichte an und prüft Art-Filter, Einheit, „Zur Einkaufsliste“ und die Wochenplan-Auswahl. Es wird nichts an Supabase gesendet.

## Sicherheit

Im Repo stehen nur Projektadresse und öffentlicher (anon/publishable) Schlüssel. Den `service_role`-Schlüssel gehört nie hierher.
