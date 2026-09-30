# Schatzsuche am Chrischtchindlimärit

Eine Schnitzeljagd für Kinder am Chrischtchindlimärit in Steffisburg
(Zulgstrasse, zwischen Dorfkreisel und Schönaubrücke).

An verschiedenen Ständen hängen QR-Codes. Die Kinder lesen auf ihrer
**Stempelkarte** ein Rätsel («Wo riecht es fein nach heissem Käse?»),
suchen den Stand und scannen den Code. Dafür gibt es einen Stempel, ein
kleines Wissens-Häppchen und der Schatz erscheint auf der **Karte**.
Wer alle findet, sieht die Schlussbotschaft, zum Beispiel «Hol dir am
Info-Stand eine Überraschung ab».

## Rollen

| Rolle | Adresse | Kann |
|-------|---------|------|
| Kinder | `/` | Stempelkarte mit allen Rätseln, Karte mit den **gefundenen** Schätzen, Scanner |
| Admin | `/admin` | Schätze anlegen, auf der Karte platzieren und verschieben, Texte bearbeiten, QR-Plakate und Start-Plakat drucken, Konfiguration exportieren und importieren |

## Wo was gespeichert wird

- **Konfiguration** (Titel, Karte, Schätze mit Ort und Geheimcode): eine
  JSON-Datei auf dem Server (`DATA_FILE`, im Container `/data/config.json`).
  Beim ersten Start wird `config/default-config.json` kopiert, und jeder
  Schatz bekommt seinen Geheimcode.
- **Fortschritt der Kinder**: nur im `localStorage` des jeweiligen Handys.
  Der Server kennt keine Spieler und speichert nichts über sie.

Vor dem Fund liefert die API nur das Rätsel, nicht den Ort und nicht den
Geheimcode (`GET /api/game`). Den Ort gibt es erst mit dem gescannten Code
(`GET /api/find/:code`).

## QR-Codes

Ein QR-Code enthält `https://<adresse>/f/<GEHEIMCODE>`. Er funktioniert
mit dem eingebauten Scanner der App und auch mit der normalen Kamera-App:
die öffnet die Seite, und der Stempel wird gesetzt. Unter jedem QR-Code
steht der Geheimcode (z. B. `MBQ8-JZEW`) zum Abtippen, falls keine Kamera
geht.

Der Geheimcode bleibt beim Bearbeiten erhalten. Wird ein Schatz gelöscht,
funktioniert sein aufgehängter Code nicht mehr.

Gedruckt werden zwei A5-Plakate pro A4-Seite (im Druckdialog «Hintergrund
drucken» einschalten, damit die Farben mitkommen).

## Betrieb

| Variable | Zweck |
|----------|-------|
| `ADMIN_PASSWORD` | Passwort für `/admin`. Ohne Passwort bleibt das Admin-UI gesperrt. |
| `SECRET` | Schlüssel für die Admin-Tokens. Fest setzen, sonst endet jede Anmeldung mit einem Neustart. |
| `DATA_FILE` | Pfad zur Konfiguration, Standard `data/config.json` |
| `PORT` | Standard `3000` |

```sh
npm run dev      # http://localhost:3000, Admin-Passwort "admin"
npm test
```

Keine Abhängigkeiten ausser Node ≥ 22. Leaflet, jsQR und qrcode-generator
liegen fertig unter `public/vendor/` (mit ihren Lizenzen). Die Kartenkacheln
kommen von OpenStreetMap.

Deployt wird es in hoops als Stack `schatzsuche`
(`services/schatzsuche`, gepinnt auf einen Commit dieses Repos).
