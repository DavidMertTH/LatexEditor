# Folio – lokaler LaTeX-Editor

Ein LaTeX-Editor im Browser, ähnlich wie Overleaf – aber die Dateien liegen ganz normal auf deinem Rechner.

## Installation

```bash
./install.sh
```

Der Installer prüft Node.js (≥ 20.19), installiert die Abhängigkeiten, baut die Oberfläche, bietet die Installation eines LaTeX-Compilers an (Tectonic oder TeX Live) und legt an:

- den Befehl **`folio`** in `~/.local/bin` – startet den Server bei Bedarf und öffnet den Editor (in Chromium/Chrome/Brave als eigenes App-Fenster)
- einen Eintrag im **Startmenü**
- auf Wunsch einen **Autostart-Dienst** (`systemctl --user`), der den Server beim Anmelden startet

```bash
folio            # starten und öffnen
folio stop       # Server beenden (außerdem: start, restart, status, logs, update)
```

Optionen: `--yes` (ohne Rückfragen), `--tex=tectonic|texlive|none`, `--port=4242`, `--service`/`--no-service`, `--no-desktop`, `--uninstall` (entfernt Befehl, Startmenü-Eintrag und Dienst – Projekte bleiben erhalten).

### Ohne Installer

```bash
npm install
npm start        # baut die Oberfläche und startet den Server auf http://localhost:4242
npm run dev      # Entwicklung mit Hot-Reload auf http://localhost:5173
```

Umgebungsvariablen: `PORT` (Standard 4242), `LATEX_WORKSPACE` (Ordner für neue Projekte, Standard `./projects`).

## LaTeX-Compiler

Zum Rendern wird ein TeX-System benötigt. Unterstützt werden `latexmk`/pdfLaTeX/XeLaTeX/LuaLaTeX (TeX Live) und Tectonic.

```bash
# schlank – lädt benötigte Pakete automatisch nach
sudo pacman -S tectonic
# oder vollständiges TeX Live
sudo pacman -S texlive-basic texlive-latex texlive-latexrecommended texlive-latexextra \
  texlive-fontsrecommended texlive-langgerman texlive-binextra texlive-bibtexextra biber
```

Ein ausführbares Programm in `./bin/` (z. B. `bin/tectonic`) wird ebenfalls erkannt. Nach der Installation den Server neu starten.

## Funktionen

- **Ansichten:** Editor, Geteilt (Code links, PDF rechts, Trenner verschiebbar) und nur PDF
- **Visueller Modus:** direkt im „gerenderten“ Dokument schreiben – Überschriften, Formeln (KaTeX), Listen, Bilder, Tabellen, Verweise und Zitate werden dargestellt; Klick auf ein Element zeigt den Quelltext zum Bearbeiten
- **Autovervollständigung:** ~400 Befehle und Umgebungen mit Platzhaltern, `\ref`/`\eqref` mit allen Labels, `\cite` mit Einträgen aus `.bib`-Dateien, Dateipfade für `\input`/`\includegraphics`, Pakete, eigene `\newcommand`s
- **Kompilieren:** automatisch nach Änderungen oder mit Strg+S, Fehler/Warnungen im Protokoll und direkt im Code markiert
- **SyncTeX:** Doppelklick im PDF springt zur Stelle im Code, Strg+. springt vom Code ins PDF
- **Dateien:** Dateibaum mit Anlegen, Umbenennen, Verschieben (Drag & Drop), Hochladen; Bilder in den Editor ziehen fügt eine Abbildung ein. Gelöschtes landet in `.trash` im Projekt
- Änderungen von außen (anderer Editor, git) werden live übernommen
- Hell/Dunkel, PDF-Dunkelmodus, Gliederung, Suchen & Ersetzen, Code-Faltung

## Tastenkürzel

| Kürzel | Aktion |
| --- | --- |
| Strg+S / Strg+Enter | Speichern & kompilieren |
| Strg+B / Strg+I / Strg+U | Fett / kursiv / unterstrichen |
| Strg+/ | Zeilen auskommentieren |
| Strg+. | Zur Stelle im PDF springen |
| Strg+Shift+E | Quelltext ↔ Visuell |
| Strg+\ | Seitenleiste ein/aus |
| Strg+F | Suchen & Ersetzen |
| Strg+Leertaste | Vervollständigung öffnen |

Kompilate liegen in `.latex-out/` im jeweiligen Projektordner; Projekteinstellungen (Hauptdatei, Compiler) in `.latexeditor.json`.
