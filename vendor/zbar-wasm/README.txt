Anleitung: zbar-wasm lokal hinzufügen

1) Mit npm (empfohlen, wenn vorhanden):

   npm pack zbar-wasm

   Dadurch wird eine Datei wie `zbar-wasm-<version>.tgz` erstellt. Entpacke sie
   und kopiere die Dateien aus `package/dist/` in dieses Verzeichnis.

   Beispiel (Linux/macOS):

     mkdir /tmp/zbar && cd /tmp/zbar
     npm pack zbar-wasm
     tar xzf zbar-wasm-*.tgz
     cp package/dist/* <pfad-zum-repo>/vendor/zbar-wasm/

2) Ohne npm: lade die offiziellen Build‑Artefakte (`index.min.js` und `zbar.wasm`)
   von einer vertrauenswürdigen Quelle (z. B. Release‑Artifakt des Projekts) und
   platziere sie hier.

3) Nach dem Kopieren sollten die Dateien mindestens `index.min.js` und
   `zbar.wasm` in diesem Ordner sein. Die App lädt dann die lokale `index.min.js`.

Hinweis: Wenn Tracking/Privacy‑Einstellungen den Zugriff auf CDN Ressourcen blockieren,
lokales Hosting der Dateien ist die einfachste Lösung.
