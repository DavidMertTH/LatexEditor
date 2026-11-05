#!/usr/bin/env bash
# Folio – Installer
#
# Richtet den LaTeX-Editor ein:
#   1. prüft Node.js / npm (und installiert sie auf Wunsch)
#   2. installiert die npm-Abhängigkeiten und baut die Oberfläche
#   3. installiert auf Wunsch einen LaTeX-Compiler (Tectonic oder TeX Live)
#   4. legt den Befehl `folio`, einen Startmenü-Eintrag und optional einen Autostart-Dienst an
#
# Aufruf:  ./install.sh [Optionen]
#   -y, --yes              alle Fragen mit der Vorgabe beantworten
#   --tex=MODE             tectonic | texlive | none   (Standard: fragen)
#   --port=PORT            Port des Servers (Standard: 4242)
#   --service / --no-service   Autostart als systemd-Benutzerdienst (Standard: fragen)
#   --no-desktop           keinen Startmenü-Eintrag anlegen
#   --uninstall            Befehl, Startmenü-Eintrag und Dienst wieder entfernen (Projekte bleiben erhalten)
#   -h, --help             diese Hilfe

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Folio"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=19

BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
LAUNCHER="$BIN_DIR/folio"
DESKTOP_FILE="$DATA_HOME/applications/folio.desktop"
ICON_FILE="$DATA_HOME/icons/hicolor/scalable/apps/folio.svg"
SERVICE_FILE="$CONFIG_HOME/systemd/user/folio.service"

ASSUME_YES=0
TEX_MODE=""
PORT=4242
SERVICE=""
DESKTOP=1
UNINSTALL=0

# ── Ausgabe ────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  B=$'\e[1m' D=$'\e[2m' R=$'\e[0m' V=$'\e[38;5;99m' G=$'\e[32m' Y=$'\e[33m' E=$'\e[31m' INV=$'\e[7m'
else
  B="" D="" R="" V="" G="" Y="" E="" INV=""
fi
step() { printf '\n%s▍%s %s%s%s\n' "$V" "$R" "$B" "$*" "$R"; }
info() { printf '  %s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$G" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$R" "$*"; }
die() {
  printf '\n  %s✗ %s%s\n\n' "$E" "$*" "$R" >&2
  exit 1
}

# ask "Frage" [default y|n] → 0 = ja
ask() {
  local question="$1" default="${2:-y}" answer hint
  [[ $default == y ]] && hint="J/n" || hint="j/N"
  if ((ASSUME_YES)) || [[ ! -t 0 ]]; then
    [[ $default == y ]]
    return
  fi
  read -r -p "  $question [$hint] " answer || answer=""
  answer="${answer:-$default}"
  [[ $answer =~ ^[jJyY] ]]
}

# choose "Frage" default opt1 opt2 … → echo gewählte Option
choose() {
  local question="$1" default="$2"
  shift 2
  local opts=("$@") i answer
  if ((ASSUME_YES)) || [[ ! -t 0 ]]; then
    echo "$default"
    return
  fi
  {
    printf '  %s\n' "$question"
    for i in "${!opts[@]}"; do
      local mark=" "
      [[ ${opts[$i]%%:*} == "$default" ]] && mark="${V}›${R}"
      printf '   %s %d) %s\n' "$mark" "$((i + 1))" "${opts[$i]#*:}"
    done
  } >&2
  read -r -p "  Auswahl [Enter = Vorgabe]: " answer || answer=""
  if [[ $answer =~ ^[0-9]+$ ]] && ((answer >= 1 && answer <= ${#opts[@]})); then
    echo "${opts[$((answer - 1))]%%:*}"
  else
    echo "$default"
  fi
}

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    -y | --yes) ASSUME_YES=1 ;;
    --tex=*) TEX_MODE="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    --service) SERVICE=1 ;;
    --no-service) SERVICE=0 ;;
    --no-desktop) DESKTOP=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) usage ;;
    *) die "Unbekannte Option: $arg (siehe --help)" ;;
  esac
done
[[ $TEX_MODE =~ ^(|tectonic|texlive|none)$ ]] || die "--tex muss tectonic, texlive oder none sein"
[[ $PORT =~ ^[0-9]+$ ]] || die "--port muss eine Zahl sein"

# ── System erkennen ────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
PM=""
for candidate in pacman apt-get dnf zypper brew; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PM="$candidate"
    break
  fi
done

SUDO=""
if [[ $EUID -ne 0 && $PM != brew ]]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi

pm_install() {
  case "$PM" in
    pacman) $SUDO pacman -S --needed --noconfirm "$@" ;;
    apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y "$@" ;;
    dnf) $SUDO dnf install -y "$@" ;;
    zypper) $SUDO zypper --non-interactive install "$@" ;;
    brew) brew install "$@" ;;
    *) return 1 ;;
  esac
}

has_systemd_user() {
  [[ $OS == Linux ]] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

# ── Deinstallation ─────────────────────────────────────────────────────────
if ((UNINSTALL)); then
  step "$APP_NAME deinstallieren"
  if [[ -f $SERVICE_FILE ]] && has_systemd_user; then
    systemctl --user disable --now folio.service >/dev/null 2>&1 || true
    rm -f "$SERVICE_FILE"
    systemctl --user daemon-reload || true
    ok "Autostart-Dienst entfernt"
  fi
  [[ -x $LAUNCHER ]] && "$LAUNCHER" stop >/dev/null 2>&1 || true
  for f in "$LAUNCHER" "$DESKTOP_FILE" "$ICON_FILE"; do
    if [[ -e $f ]]; then
      rm -f "$f"
      ok "entfernt: $f"
    fi
  done
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
  info ""
  info "Programmordner und Projekte wurden ${B}nicht${R} gelöscht:"
  info "  $APP_DIR"
  exit 0
fi

printf '\n  %s%s Tχ %s  %s%s%s – Installation\n' "$V" "$INV" "$R" "$B" "$APP_NAME" "$R"
info "${D}Ordner: $APP_DIR${R}"
info "${D}System: $OS $ARCH${PM:+ · Paketmanager: $PM}${R}"

# ── 1. Node.js ─────────────────────────────────────────────────────────────
step "Node.js prüfen"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${v%%.*}"
  minor="$(cut -d. -f2 <<<"$v")"
  ((major > MIN_NODE_MAJOR || (major == MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)))
}

if ! node_ok || ! command -v npm >/dev/null 2>&1; then
  if command -v node >/dev/null 2>&1; then
    warn "Node.js $(node -v) ist zu alt – benötigt wird mindestens v$MIN_NODE_MAJOR.$MIN_NODE_MINOR"
  else
    warn "Node.js ist nicht installiert"
  fi
  [[ -n $PM ]] || die "Bitte Node.js ≥ $MIN_NODE_MAJOR.$MIN_NODE_MINOR installieren (https://nodejs.org) und das Skript erneut starten."
  if ask "Node.js und npm über $PM installieren?" y; then
    case "$PM" in
      pacman) pm_install nodejs npm ;;
      brew) pm_install node ;;
      *) pm_install nodejs npm ;;
    esac
  fi
  node_ok || die "Node.js ≥ $MIN_NODE_MAJOR.$MIN_NODE_MINOR wird benötigt. Installiere eine aktuelle Version (z. B. über https://nodejs.org oder nvm) und starte das Skript erneut."
fi
NODE_BIN="$(command -v node)"
ok "Node.js $(node -v) · npm $(npm -v)"

# ── 2. Abhängigkeiten & Build ──────────────────────────────────────────────
step "Abhängigkeiten installieren"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund --loglevel=error
else
  npm install --no-audit --no-fund --loglevel=error
fi
ok "npm-Pakete installiert"

step "Oberfläche bauen"
npm run build --silent >/dev/null
[[ -f dist/index.html ]] || die "Build fehlgeschlagen (dist/index.html fehlt)"
ok "Gebaut nach dist/"
mkdir -p "$APP_DIR/projects"

# ── 3. LaTeX-Compiler ──────────────────────────────────────────────────────
step "LaTeX-Compiler"
found=()
for bin in latexmk pdflatex xelatex lualatex tectonic; do
  command -v "$bin" >/dev/null 2>&1 && found+=("$bin")
done
[[ -x $APP_DIR/bin/tectonic ]] && found+=("bin/tectonic")

if ((${#found[@]})) && [[ -z $TEX_MODE ]]; then
  ok "Gefunden: ${found[*]}"
  TEX_MODE="none"
elif [[ -z $TEX_MODE ]]; then
  warn "Kein LaTeX-Compiler gefunden – ohne Compiler kann kein PDF erzeugt werden."
  TEX_MODE="$(choose "Was soll installiert werden?" tectonic \
    "tectonic:Tectonic  – klein (~40 MB), lädt Pakete bei Bedarf automatisch (empfohlen)" \
    "texlive:TeX Live   – vollständig und offline nutzbar (mehrere GB)" \
    "none:Nichts      – später selbst installieren")"
fi

install_tectonic_binary() {
  # Offizielles Release von GitHub nach ./bin – Fallback, wenn der Paketmanager kein Tectonic hat.
  local target asset_url tmp
  case "$OS-$ARCH" in
    Linux-x86_64) target="x86_64-unknown-linux-musl" ;;
    Linux-aarch64 | Linux-arm64) target="aarch64-unknown-linux-musl" ;;
    Darwin-x86_64) target="x86_64-apple-darwin" ;;
    Darwin-arm64) target="aarch64-apple-darwin" ;;
    *) return 1 ;;
  esac
  command -v curl >/dev/null 2>&1 || return 1
  asset_url="$(curl -fsSL https://api.github.com/repos/tectonic-typesetting/tectonic/releases/latest |
    grep -o "\"browser_download_url\": *\"[^\"]*${target}\.tar\.gz\"" | head -n1 | sed 's/.*"\(https[^"]*\)"/\1/')" || return 1
  [[ -n $asset_url ]] || return 1
  info "Lade ${asset_url##*/} …"
  tmp="$(mktemp -d)"
  curl -fsSL "$asset_url" -o "$tmp/tectonic.tar.gz" && tar -xzf "$tmp/tectonic.tar.gz" -C "$tmp" || {
    rm -rf "$tmp"
    return 1
  }
  mkdir -p "$APP_DIR/bin"
  install -m 755 "$tmp/tectonic" "$APP_DIR/bin/tectonic"
  rm -rf "$tmp"
  "$APP_DIR/bin/tectonic" --version >/dev/null
}

case "$TEX_MODE" in
  tectonic)
    installed=0
    if [[ -n $PM ]]; then
      info "Installiere Tectonic über $PM …"
      pm_install tectonic && installed=1 || warn "$PM konnte Tectonic nicht installieren."
    fi
    if ((!installed)); then
      if ask "Tectonic stattdessen direkt von GitHub nach ./bin laden?" y; then
        install_tectonic_binary && installed=1 || warn "Download fehlgeschlagen."
      fi
    fi
    if ((installed)); then
      ok "Tectonic installiert – beim ersten Kompilieren werden benötigte Pakete einmalig geladen."
    else
      warn "Tectonic wurde nicht installiert. Siehe README für manuelle Installation."
    fi
    ;;
  texlive)
    info "Installiere TeX Live über ${PM:-?} – das kann eine Weile dauern …"
    case "$PM" in
      pacman) pm_install texlive-basic texlive-latex texlive-latexrecommended texlive-latexextra texlive-fontsrecommended \
        texlive-langgerman texlive-binextra texlive-bibtexextra texlive-mathscience biber ;;
      apt-get) pm_install texlive-latex-extra texlive-lang-german texlive-fonts-recommended texlive-bibtex-extra \
        texlive-science latexmk biber ;;
      dnf) pm_install texlive-scheme-medium latexmk biber ;;
      zypper) pm_install texlive-scheme-medium texlive-latexmk biber ;;
      brew) brew install --cask mactex-no-gui ;;
      *) die "Kein unterstützter Paketmanager gefunden – bitte TeX Live manuell installieren (https://tug.org/texlive/)." ;;
    esac && ok "TeX Live installiert" || warn "TeX Live konnte nicht vollständig installiert werden."
    ;;
  none)
    ((${#found[@]})) || warn "Übersprungen – PDFs lassen sich erst nach Installation eines Compilers erzeugen (siehe README)."
    ;;
esac

# ── 4. Befehl `folio` ──────────────────────────────────────────────────────
step "Befehl »folio« anlegen"
mkdir -p "$BIN_DIR"
q() { printf '%q' "$1"; }
cat >"$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Folio – Starter (erzeugt von install.sh)
APP_DIR=$(q "$APP_DIR")
NODE_BIN=$(q "$NODE_BIN")
PORT="\${FOLIO_PORT:-$PORT}"
URL="http://localhost:\$PORT"
STATE_DIR="\${XDG_STATE_HOME:-\$HOME/.local/state}/folio"
LOG="\$STATE_DIR/server.log"
PID_FILE="\$STATE_DIR/server.pid"
mkdir -p "\$STATE_DIR"

running() { (exec 3<>"/dev/tcp/127.0.0.1/\$PORT") 2>/dev/null; }
uses_service() { [[ -f "\${XDG_CONFIG_HOME:-\$HOME/.config}/systemd/user/folio.service" ]] && command -v systemctl >/dev/null 2>&1; }

start() {
  running && return 0
  if uses_service; then
    systemctl --user start folio.service
  else
    (
      cd "\$APP_DIR" || exit 1
      PORT="\$PORT" nohup "\$NODE_BIN" "\$APP_DIR/server/index.js" >>"\$LOG" 2>&1 &
      echo \$! >"\$PID_FILE"
    )
  fi
  for _ in \$(seq 1 50); do
    running && return 0
    sleep 0.2
  done
  echo "Folio konnte nicht gestartet werden – siehe \$LOG" >&2
  return 1
}

stop() {
  if uses_service; then systemctl --user stop folio.service; fi
  if [[ -f "\$PID_FILE" ]]; then
    kill "\$(cat "\$PID_FILE")" 2>/dev/null || true
    rm -f "\$PID_FILE"
  fi
  # fallback: a server started by an older launcher or by hand
  pkill -f -- "\$APP_DIR/server/index.js" 2>/dev/null || true
  for _ in \$(seq 1 25); do
    running || return 0
    sleep 0.2
  done
}

open_ui() {
  if [[ -n "\${FOLIO_BROWSER:-}" ]]; then "\$FOLIO_BROWSER" "\$URL" >/dev/null 2>&1 & return; fi
  # Chromium-basierte Browser öffnen Folio als eigenes App-Fenster
  for b in chromium google-chrome-stable google-chrome brave brave-browser microsoft-edge-stable vivaldi-stable; do
    if command -v "\$b" >/dev/null 2>&1; then "\$b" --app="\$URL" >/dev/null 2>&1 & return; fi
  done
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "\$URL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "\$URL"
  else echo "Folio läuft auf \$URL"; fi
}

case "\${1:-open}" in
  open | "") start && open_ui ;;
  start) start && echo "Folio läuft auf \$URL" ;;
  stop) stop && echo "Folio gestoppt" ;;
  restart) stop; sleep 0.5; start && echo "Folio läuft auf \$URL" ;;
  status) if running; then echo "Folio läuft auf \$URL"; else echo "Folio läuft nicht"; exit 1; fi ;;
  logs) if uses_service; then journalctl --user -u folio.service -f; else tail -f "\$LOG"; fi ;;
  update) (cd "\$APP_DIR" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent) && "\$0" restart ;;
  -h | --help | help)
    echo "Aufruf: folio [open|start|stop|restart|status|logs|update]"
    echo "  open     Server starten (falls nötig) und Editor öffnen (Standard)"
    echo "  update   Abhängigkeiten aktualisieren, neu bauen und neu starten"
    echo "Umgebung: FOLIO_PORT, FOLIO_BROWSER" ;;
  *) echo "Unbekannter Befehl: \$1 (folio help)" >&2; exit 1 ;;
esac
EOF
chmod +x "$LAUNCHER"
ok "$LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR ist nicht im PATH. Ergänze in deiner Shell-Konfiguration: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# ── 5. Startmenü-Eintrag ───────────────────────────────────────────────────
if ((DESKTOP)) && [[ $OS == Linux ]]; then
  step "Startmenü-Eintrag"
  mkdir -p "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
  cp "$APP_DIR/client/public/favicon.svg" "$ICON_FILE"
  cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
GenericName=LaTeX-Editor
Comment=LaTeX schreiben mit Live-Vorschau
Exec="$LAUNCHER" open
Icon=folio
Terminal=false
Categories=Office;Publishing;TextEditor;
Keywords=LaTeX;TeX;PDF;Editor;
StartupNotify=false
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true
  ok "$DESKTOP_FILE"
fi

# ── 6. Autostart (systemd) ─────────────────────────────────────────────────
if has_systemd_user; then
  if [[ -z $SERVICE ]]; then
    ask "Folio-Server beim Anmelden automatisch im Hintergrund starten?" n && SERVICE=1 || SERVICE=0
  fi
  if ((SERVICE)); then
    step "Autostart-Dienst"
    "$LAUNCHER" stop >/dev/null 2>&1 || true
    mkdir -p "$(dirname "$SERVICE_FILE")"
    cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Folio LaTeX-Editor
After=default.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart="$NODE_BIN" "$APP_DIR/server/index.js"
Environment=PORT=$PORT
Environment="PATH=$APP_DIR/bin:$PATH"
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now folio.service >/dev/null 2>&1
    ok "Dienst folio.service aktiv"
  elif [[ -f $SERVICE_FILE ]]; then
    systemctl --user disable --now folio.service >/dev/null 2>&1 || true
    rm -f "$SERVICE_FILE"
    systemctl --user daemon-reload || true
    info "Vorhandener Autostart-Dienst entfernt"
  fi
elif [[ $SERVICE == 1 ]]; then
  warn "systemd (Benutzer) ist nicht verfügbar – Autostart übersprungen."
fi

# ── Fertig ─────────────────────────────────────────────────────────────────
step "Fertig"
info "Starten:        ${B}folio${R}   ${D}(oder über das Startmenü)${R}"
info "Adresse:        http://localhost:$PORT"
info "Weitere Befehle: folio start | stop | restart | status | logs | update"
info "Deinstallieren: ./install.sh --uninstall"
echo
