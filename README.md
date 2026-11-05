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

### Windows

`install.cmd` doppelklicken – oder im Terminal:

```bat
install.cmd
```

Der Installer prüft Node.js (installiert es bei Bedarf über `winget`), baut die Oberfläche, bietet Tectonic (Download nach `bin\`) oder MiKTeX (über `winget`) an und legt an:

- eine Verknüpfung **Folio** auf dem **Desktop** und im **Startmenü** – startet den Server unsichtbar im Hintergrund und öffnet den Editor (in Chrome/Brave/Edge als eigenes App-Fenster)
- den Befehl **`folio`** (`%LOCALAPPDATA%\Folio\bin`, wird zum Benutzer-PATH hinzugefügt – gilt in neu geöffneten Terminals) mit denselben Unterbefehlen wie unter Linux
- auf Wunsch einen **Autostart**-Eintrag, der den Server beim Anmelden startet

Optionen: `--yes`, `--tex=tectonic|miktex|none`, `--port=4242`, `--autostart`/`--no-autostart`, `--no-desktop`, `--no-startmenu`, `--uninstall`. Das Server-Log liegt in `%LOCALAPPDATA%\Folio\server.log` (`folio logs`).

Mit MiKTeX wird `latexmk` nur genutzt, wenn Perl installiert ist (z. B. Strawberry Perl); sonst ruft Folio pdfLaTeX/BibTeX/Biber direkt auf.

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
- **GitHub-Sync:** Ist der geöffnete Ordner ein Git-Repository mit Remote, wird er automatisch verknüpft: beim Öffnen und sobald neue Commits auf GitHub liegen wird gepullt (Prüfung alle 20 s), lokale Änderungen werden jede Minute committet und gepusht. Über den Branch-Knopf oben rechts gibt es „Pull“ und „Commit & Push“ (mit optionaler Nachricht) sowie den Schalter für die Automatik. Ordner ohne Repository lassen sich dort per GitHub-URL verknüpfen. Bei Konflikten wählst du, ob deine oder die GitHub-Version gilt. `.latex-out/` und `.trash/` werden nie committet. Voraussetzung: `git` ist installiert und einmal bei GitHub angemeldet (z. B. über den Git Credential Manager oder `gh auth login`).
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
