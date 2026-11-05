# Folio – Installer für Windows
#
# Richtet den LaTeX-Editor ein:
#   1. prüft Node.js / npm (und installiert sie auf Wunsch über winget)
#   2. installiert die npm-Abhängigkeiten und baut die Oberfläche
#   3. installiert auf Wunsch einen LaTeX-Compiler (Tectonic oder MiKTeX)
#   4. legt den Befehl `folio`, Verknüpfungen auf dem Desktop und im Startmenü
#      und optional einen Autostart-Eintrag an
#
# Aufruf:  install.cmd [Optionen]      (oder: powershell -ExecutionPolicy Bypass -File install.ps1 …)
#   -y, --yes              alle Fragen mit der Vorgabe beantworten
#   --tex=MODE             tectonic | miktex | none   (Standard: fragen)
#   --port=PORT            Port des Servers (Standard: 4242)
#   --autostart / --no-autostart   Server beim Anmelden starten (Standard: fragen)
#   --no-desktop           keine Desktop-Verknüpfung anlegen
#   --no-startmenu         keinen Startmenü-Eintrag anlegen
#   --uninstall            Befehl, Verknüpfungen und Autostart entfernen (Projekte bleiben erhalten)
#   -h, --help             diese Hilfe

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$AppDir = $PSScriptRoot
$AppName = 'Folio'
$MinNode = [version]'20.19'

$FolioHome = Join-Path $env:LOCALAPPDATA 'Folio'
$BinDir = Join-Path $FolioHome 'bin'
$LauncherPs1 = Join-Path $FolioHome 'folio.ps1'
$LauncherCmd = Join-Path $BinDir 'folio.cmd'
$IconFile = Join-Path $FolioHome 'folio.ico'
$DesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
$StartMenuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"
$StartupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) "$AppName (Server).lnk"

$AssumeYes = $false
$TexMode = ''
$Port = 4242
$Autostart = $null
$Desktop = $true
$StartMenu = $true
$Uninstall = $false

# ── Ausgabe ────────────────────────────────────────────────────────────────
function Step($t) { Write-Host ''; Write-Host '» ' -ForegroundColor Magenta -NoNewline; Write-Host $t -ForegroundColor White }
function Info($t) { Write-Host "  $t" }
function Dim($t) { Write-Host "  $t" -ForegroundColor DarkGray }
function Ok($t) { Write-Host '  √ ' -ForegroundColor Green -NoNewline; Write-Host $t }
function Warn($t) { Write-Host '  ! ' -ForegroundColor Yellow -NoNewline; Write-Host $t }
function Die($t) { Write-Host ''; Write-Host "  × $t" -ForegroundColor Red; Write-Host ''; exit 1 }

function Test-Interactive { -not $AssumeYes -and -not [Console]::IsInputRedirected }

# Ask "Frage" $true/$false → $true = ja
function Ask([string]$Question, [bool]$Default = $true) {
  if (-not (Test-Interactive)) { return $Default }
  $hint = if ($Default) { 'J/n' } else { 'j/N' }
  $answer = Read-Host "  $Question [$hint]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer -match '^[jJyY]'
}

# Choose "Frage" default @('id:Text', …) → gewählte id
function Choose([string]$Question, [string]$Default, [string[]]$Options) {
  if (-not (Test-Interactive)) { return $Default }
  Info $Question
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $id, $text = $Options[$i] -split ':', 2
    $mark = if ($id -eq $Default) { '›' } else { ' ' }
    Write-Host "   $mark $($i + 1)) $text"
  }
  $answer = Read-Host '  Auswahl [Enter = Vorgabe]'
  $n = 0
  if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $Options.Count) { return ($Options[$n - 1] -split ':', 2)[0] }
  return $Default
}

# Führt ein Konsolenprogramm über cmd.exe aus, damit stderr-Ausgaben (z. B. npm-Warnungen)
# in Windows PowerShell 5.1 nicht als Fehler gelten. Gibt den Exit-Code zurück.
function Invoke-Cmd([string]$CommandLine) {
  & $env:ComSpec /d /s /c "$CommandLine 2>&1" | Out-Host
  return $LASTEXITCODE
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Show-Usage {
  foreach ($line in (Get-Content $PSCommandPath -Encoding UTF8 | Select-Object -Skip 2)) {
    if ($line -notmatch '^#') { break }
    Write-Host ($line -replace '^# ?', '')
  }
  exit 0
}

# ── Optionen (Linux-Stil --tex=x wie in install.sh, aber auch -Tex x) ─────
$argv = @($args)
for ($i = 0; $i -lt $argv.Count; $i++) {
  $a = [string]$argv[$i]
  $value = $null
  if ($a -match '^--?([^=]+)=(.*)$') { $name = $Matches[1]; $value = $Matches[2] } else { $name = $a -replace '^--?', '' }
  $next = { if ($null -ne $value) { $value } elseif ($i + 1 -lt $argv.Count) { $script:i++; [string]$argv[$script:i] } else { Die "Option $a braucht einen Wert" } }
  switch ($name.ToLower()) {
    { $_ -in 'y', 'yes' } { $AssumeYes = $true }
    'tex' { $TexMode = (& $next).ToLower() }
    'port' { $Port = & $next }
    { $_ -in 'autostart', 'service' } { $Autostart = $true }
    { $_ -in 'no-autostart', 'no-service' } { $Autostart = $false }
    'no-desktop' { $Desktop = $false }
    'no-startmenu' { $StartMenu = $false }
    'uninstall' { $Uninstall = $true }
    { $_ -in 'h', 'help', '?' } { Show-Usage }
    default { Die "Unbekannte Option: $a (siehe --help)" }
  }
}
if ($TexMode -eq 'texlive') { Die 'TeX Live bitte manuell installieren (https://tug.org/texlive/windows.html) – oder --tex=miktex verwenden.' }
if ($TexMode -notin '', 'tectonic', 'miktex', 'none') { Die '--tex muss tectonic, miktex oder none sein' }
if ("$Port" -notmatch '^\d+$') { Die '--port muss eine Zahl sein' }
$Port = [int]$Port

# ── Benutzer-PATH (Registry, %VARIABLEN% bleiben erhalten) ────────────────
function Get-UserPathRaw {
  $key = Get-Item 'HKCU:\Environment'
  return [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
}
function Set-UserPathRaw([string]$Value) {
  Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $Value -Type ExpandString
  # Explorer & neue Terminals über die Änderung informieren
  if (-not ('Folio.Native' -as [type])) {
    Add-Type -Namespace Folio -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  }
  $result = [UIntPtr]::Zero
  [void][Folio.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}
function Test-InUserPath([string]$Dir) {
  return (Get-UserPathRaw) -split ';' | Where-Object { $_ -and ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $Dir.TrimEnd('\')) }
}

function New-Shortcut([string]$Path, [string]$Arguments, [string]$Description, [int]$WindowStyle = 7) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPs1`" $Arguments"
  $lnk.WorkingDirectory = $AppDir
  $lnk.Description = $Description
  $lnk.WindowStyle = $WindowStyle   # 7 = minimiert, damit kein Konsolenfenster aufblitzt
  if (Test-Path $IconFile) { $lnk.IconLocation = "$IconFile,0" }
  $lnk.Save()
}

# ── Deinstallation ─────────────────────────────────────────────────────────
if ($Uninstall) {
  Step "$AppName deinstallieren"
  if (Test-Path $LauncherPs1) { try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $LauncherPs1 stop | Out-Null } catch {} }
  foreach ($f in $DesktopLnk, $StartMenuLnk, $StartupLnk) {
    if (Test-Path $f) { Remove-Item $f -Force; Ok "entfernt: $f" }
  }
  if (Test-InUserPath $BinDir) {
    $rest = (Get-UserPathRaw) -split ';' | Where-Object { $_ -and ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ine $BinDir.TrimEnd('\')) }
    Set-UserPathRaw ($rest -join ';')
    Ok "$BinDir aus dem PATH entfernt"
  }
  if (Test-Path $FolioHome) { Remove-Item $FolioHome -Recurse -Force; Ok "entfernt: $FolioHome" }
  Info ''
  Info 'Programmordner und Projekte wurden NICHT gelöscht:'
  Info "  $AppDir"
  exit 0
}

$arch = $env:PROCESSOR_ARCHITECTURE
Write-Host ''
Write-Host '  ' -NoNewline; Write-Host ' Tχ ' -BackgroundColor DarkMagenta -ForegroundColor White -NoNewline; Write-Host "  $AppName" -ForegroundColor White -NoNewline; Write-Host ' – Installation'
Dim "Ordner: $AppDir"
Dim "System: Windows $([Environment]::OSVersion.Version) $arch"

# ── 1. Node.js ─────────────────────────────────────────────────────────────
Step 'Node.js prüfen'
function Get-NodeVersion {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $null }
  try { return [version]((& node.exe -p 'process.versions.node') -replace '[^\d.]', '') } catch { return $null }
}
$nodeVersion = Get-NodeVersion
if (-not $nodeVersion -or $nodeVersion -lt $MinNode -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  if ($nodeVersion) { Warn "Node.js v$nodeVersion ist zu alt – benötigt wird mindestens v$MinNode" } else { Warn 'Node.js ist nicht installiert' }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { Die "Bitte Node.js ≥ $MinNode installieren (https://nodejs.org) und den Installer erneut starten." }
  if (Ask 'Node.js (LTS) über winget installieren?' $true) {
    $rc = Invoke-Cmd 'winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements'
    if ($rc -ne 0) { Warn "winget meldet Exit-Code $rc" }
    Update-SessionPath
    $nodeVersion = Get-NodeVersion
  }
  if (-not $nodeVersion -or $nodeVersion -lt $MinNode) { Die "Node.js ≥ $MinNode wird benötigt. Installiere eine aktuelle Version (https://nodejs.org) und starte den Installer erneut." }
}
$NodeBin = (Get-Command node.exe).Source
Ok "Node.js v$nodeVersion · npm $((& $env:ComSpec /d /c 'npm -v') | Select-Object -Last 1)"

# ── 2. Abhängigkeiten & Build ──────────────────────────────────────────────
Push-Location $AppDir
try {
  Step 'Abhängigkeiten installieren'
  $npmCmd = if (Test-Path 'package-lock.json') { 'npm ci' } else { 'npm install' }
  if ((Invoke-Cmd "$npmCmd --no-audit --no-fund --loglevel=error") -ne 0) { Die 'npm-Installation fehlgeschlagen' }
  Ok 'npm-Pakete installiert'

  Step 'Oberfläche bauen'
  if ((Invoke-Cmd 'npm run build --silent >nul') -ne 0 -or -not (Test-Path 'dist\index.html')) { Die 'Build fehlgeschlagen (dist\index.html fehlt)' }
  Ok 'Gebaut nach dist\'
} finally { Pop-Location }
New-Item -ItemType Directory -Force (Join-Path $AppDir 'projects') | Out-Null

# ── 3. LaTeX-Compiler ──────────────────────────────────────────────────────
Step 'LaTeX-Compiler'
$found = @('latexmk', 'pdflatex', 'xelatex', 'lualatex', 'tectonic') | Where-Object { Get-Command "$_.exe" -ErrorAction SilentlyContinue }
if (Test-Path (Join-Path $AppDir 'bin\tectonic.exe')) { $found += 'bin\tectonic.exe' }

if ($found -and -not $TexMode) {
  Ok "Gefunden: $($found -join ' ')"
  $TexMode = 'none'
} elseif (-not $TexMode) {
  Warn 'Kein LaTeX-Compiler gefunden – ohne Compiler kann kein PDF erzeugt werden.'
  $TexMode = Choose 'Was soll installiert werden?' 'tectonic' @(
    'tectonic:Tectonic – klein (~40 MB), lädt Pakete bei Bedarf automatisch (empfohlen)',
    'miktex:MiKTeX   – vollständige TeX-Distribution über winget, Pakete werden bei Bedarf nachgeladen',
    'none:Nichts   – später selbst installieren')
}

function Install-TectonicBinary {
  # Offizielles Release von GitHub nach .\bin (x64-Build läuft auch auf ARM64 per Emulation)
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $release = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/tectonic-typesetting/tectonic/releases/latest' -Headers @{ 'User-Agent' = 'folio-installer' }
  $asset = $release.assets | Where-Object { $_.name -like '*x86_64-pc-windows-msvc.zip' } | Select-Object -First 1
  if (-not $asset) { throw 'Kein Windows-Build im aktuellen Release gefunden' }
  Info "Lade $($asset.name) …"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("folio-" + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'tectonic.zip'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $zip
    Expand-Archive $zip -DestinationPath $tmp -Force
    $exe = Get-ChildItem $tmp -Recurse -Filter 'tectonic.exe' | Select-Object -First 1
    if (-not $exe) { throw 'tectonic.exe nicht im Archiv' }
    New-Item -ItemType Directory -Force (Join-Path $AppDir 'bin') | Out-Null
    Copy-Item $exe.FullName (Join-Path $AppDir 'bin\tectonic.exe') -Force
  } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  & (Join-Path $AppDir 'bin\tectonic.exe') --version | Out-Null
}

switch ($TexMode) {
  'tectonic' {
    try { Install-TectonicBinary; Ok 'Tectonic installiert – beim ersten Kompilieren werden benötigte Pakete einmalig geladen.' }
    catch { Warn "Tectonic konnte nicht geladen werden: $($_.Exception.Message)"; Warn 'Siehe README für manuelle Installation.' }
  }
  'miktex' {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { Die 'winget fehlt – bitte MiKTeX manuell installieren (https://miktex.org/download).' }
    Info 'Installiere MiKTeX über winget – das kann eine Weile dauern …'
    $rc = Invoke-Cmd 'winget install --id MiKTeX.MiKTeX -e --accept-source-agreements --accept-package-agreements'
    Update-SessionPath
    if (Get-Command initexmf.exe -ErrorAction SilentlyContinue) {
      # fehlende Pakete ohne Rückfrage nachladen (der Server läuft im Hintergrund, Dialoge würden blockieren)
      Invoke-Cmd 'initexmf --set-config-value=[MPM]AutoInstall=1' | Out-Null
      Ok 'MiKTeX installiert'
    } else { Warn "MiKTeX konnte nicht installiert werden (winget Exit-Code $rc)." }
  }
  'none' { if (-not $found) { Warn 'Übersprungen – PDFs lassen sich erst nach Installation eines Compilers erzeugen (siehe README).' } }
}

# ── 4. Befehl `folio` ──────────────────────────────────────────────────────
Step 'Befehl »folio« anlegen'
New-Item -ItemType Directory -Force $BinDir | Out-Null
$q = { param($s) "'" + ($s -replace "'", "''") + "'" }
$launcher = @"
# Folio – Starter (erzeugt von install.ps1)
param([string]`$Command = 'open', [switch]`$Gui)
`$ErrorActionPreference = 'Stop'
`$AppDir = $(& $q $AppDir)
`$NodeBin = $(& $q $NodeBin)
`$Port = if (`$env:FOLIO_PORT) { [int]`$env:FOLIO_PORT } else { $Port }
`$Url = "http://localhost:`$Port"
`$StateDir = $(& $q $FolioHome)
`$Log = Join-Path `$StateDir 'server.log'
`$PidFile = Join-Path `$StateDir 'server.pid'
New-Item -ItemType Directory -Force `$StateDir | Out-Null

function Fail([string]`$Message) {
  if (`$Gui) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(`$Message, 'Folio', 'OK', 'Error')
  } else { [Console]::Error.WriteLine(`$Message) }
  exit 1
}

function Test-Running {
  `$c = New-Object System.Net.Sockets.TcpClient
  try { `$r = `$c.BeginConnect('127.0.0.1', `$Port, `$null, `$null); return (`$r.AsyncWaitHandle.WaitOne(300) -and `$c.Connected) }
  catch { return `$false } finally { `$c.Close() }
}

function Start-Server {
  if (Test-Running) { return }
  `$env:PORT = "`$Port"
  # Node startet den Server losgelöst und ohne Fenster; Ausgabe landet im Log
  `$js = "const fs=require('fs');const o=fs.openSync(process.argv[2],'a');const c=require('child_process').spawn(process.execPath,[process.argv[1]],{cwd:process.argv[3],detached:true,windowsHide:true,stdio:['ignore',o,o]});console.log(c.pid);c.unref()"
  `$serverPid = & `$NodeBin -e `$js (Join-Path `$AppDir 'server\index.js') `$Log `$AppDir
  Set-Content -Path `$PidFile -Value `$serverPid
  for (`$i = 0; `$i -lt 50; `$i++) { if (Test-Running) { return }; Start-Sleep -Milliseconds 200 }
  Fail "Folio konnte nicht gestartet werden – siehe `$Log"
}

function Stop-Server {
  if (Test-Path `$PidFile) {
    `$p = Get-Content `$PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if (`$p) { Stop-Process -Id ([int]`$p) -Force -ErrorAction SilentlyContinue }
    Remove-Item `$PidFile -Force -ErrorAction SilentlyContinue
  }
  # Fallback: von Hand oder von einem älteren Starter gestarteter Server
  `$script = (Join-Path `$AppDir 'server\index.js')
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -and `$_.CommandLine.Contains(`$script) } |
    ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
  for (`$i = 0; `$i -lt 25; `$i++) { if (-not (Test-Running)) { return }; Start-Sleep -Milliseconds 200 }
}

function Find-AppBrowser {
  foreach (`$exe in 'chrome.exe', 'brave.exe', 'msedge.exe') {
    foreach (`$root in 'HKCU:', 'HKLM:', 'HKLM:\SOFTWARE\WOW6432Node') {
      `$k = "`$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\`$exe" -replace 'WOW6432Node\\SOFTWARE', 'WOW6432Node'
      `$v = (Get-ItemProperty -Path `$k -ErrorAction SilentlyContinue).'(default)'
      if (`$v -and (Test-Path `$v.Trim('"'))) { return `$v.Trim('"') }
    }
  }
  `$edge = Join-Path `${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
  if (Test-Path `$edge) { return `$edge }
  return `$null
}

function Open-UI {
  if (`$env:FOLIO_BROWSER) { Start-Process `$env:FOLIO_BROWSER `$Url; return }
  # Chromium-basierte Browser öffnen Folio als eigenes App-Fenster
  `$b = Find-AppBrowser
  if (`$b) { Start-Process `$b "--app=`$Url" } else { Start-Process `$Url }
}

switch (`$Command) {
  'open' { Start-Server; Open-UI }
  'start' { Start-Server; "Folio läuft auf `$Url" }
  'stop' { Stop-Server; 'Folio gestoppt' }
  'restart' { Stop-Server; Start-Sleep -Milliseconds 500; Start-Server; "Folio läuft auf `$Url" }
  'status' { if (Test-Running) { "Folio läuft auf `$Url" } else { 'Folio läuft nicht'; exit 1 } }
  'logs' { if (Test-Path `$Log) { Get-Content `$Log -Tail 50 -Wait -Encoding UTF8 } else { 'Noch kein Log vorhanden' } }
  'update' {
    Push-Location `$AppDir
    try {
      & `$env:ComSpec /d /s /c "npm ci --no-audit --no-fund --loglevel=error 2>&1 && npm run build --silent 2>&1" | Out-Host
      if (`$LASTEXITCODE -ne 0) { Fail 'Update fehlgeschlagen' }
    } finally { Pop-Location }
    Stop-Server; Start-Server; "Folio läuft auf `$Url"
  }
  { `$_ -in 'help', '-h', '--help' } {
    'Aufruf: folio [open|start|stop|restart|status|logs|update]'
    '  open     Server starten (falls nötig) und Editor öffnen (Standard)'
    '  update   Abhängigkeiten aktualisieren, neu bauen und neu starten'
    'Umgebung: FOLIO_PORT, FOLIO_BROWSER'
  }
  default { Fail "Unbekannter Befehl: `$Command (folio help)" }
}
"@
# UTF-8 mit BOM, damit Windows PowerShell 5.1 Umlaute korrekt liest
[IO.File]::WriteAllText($LauncherPs1, $launcher, (New-Object Text.UTF8Encoding $true))
$cmdShim = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$LauncherPs1`" %*`r`nexit /b %ERRORLEVEL%`r`n"
[IO.File]::WriteAllText($LauncherCmd, $cmdShim, (New-Object Text.ASCIIEncoding))
Ok $LauncherCmd
if (-not (Test-InUserPath $BinDir)) {
  $current = (Get-UserPathRaw).TrimEnd(';')
  Set-UserPathRaw ($(if ($current) { "$current;$BinDir" } else { $BinDir }))
  Ok "$BinDir zum Benutzer-PATH hinzugefügt (gilt für neu geöffnete Terminals)"
}

# ── 5. Symbol & Verknüpfungen ──────────────────────────────────────────────
function New-FolioIcon {
  # Nachbau von client/public/favicon.svg als .ico (PNG-Einträge, Windows Vista+)
  Add-Type -AssemblyName System.Drawing
  $sizes = 256, 48, 32, 16
  $pngs = foreach ($s in $sizes) {
    $bmp = New-Object Drawing.Bitmap $s, $s
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $r = [single]($s * 10 / 64); $d = 2 * $r; $w = [single]($s - 1)
    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($w - $d, 0, $d, $d, 270, 90)
    $path.AddArc($w - $d, $w - $d, $d, $d, 0, 90); $path.AddArc(0, $w - $d, $d, $d, 90, 90); $path.CloseFigure()
    $g.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(0x4c, 0x0d, 0xca))), $path)
    $font = New-Object Drawing.Font 'Consolas', ([single]($s * 26 / 64)), ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $g.DrawString('Tχ', $font, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF 0, ([single]($s * 0.02)), $s, $s), $fmt)
    $g.Dispose()
    $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    , $ms.ToArray()
  }
  $out = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter $out
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
  }
  foreach ($p in $pngs) { $bw.Write($p) }
  $bw.Flush(); [IO.File]::WriteAllBytes($IconFile, $out.ToArray()); $bw.Dispose()
}
try { New-FolioIcon } catch { Warn "Symbol konnte nicht erzeugt werden: $($_.Exception.Message)" }

if ($Desktop) {
  Step 'Desktop-Verknüpfung'
  New-Shortcut $DesktopLnk 'open -Gui' 'LaTeX schreiben mit Live-Vorschau'
  Ok $DesktopLnk
} elseif (Test-Path $DesktopLnk) { Remove-Item $DesktopLnk -Force }
if ($StartMenu) {
  Step 'Startmenü-Eintrag'
  New-Shortcut $StartMenuLnk 'open -Gui' 'LaTeX schreiben mit Live-Vorschau'
  Ok $StartMenuLnk
} elseif (Test-Path $StartMenuLnk) { Remove-Item $StartMenuLnk -Force }

# ── 6. Autostart ───────────────────────────────────────────────────────────
if ($null -eq $Autostart) { $Autostart = Ask 'Folio-Server beim Anmelden automatisch im Hintergrund starten?' $false }
if ($Autostart) {
  Step 'Autostart'
  New-Shortcut $StartupLnk 'start -Gui' 'Folio-Server im Hintergrund starten'
  Ok $StartupLnk
} elseif (Test-Path $StartupLnk) {
  Remove-Item $StartupLnk -Force
  Info 'Vorhandener Autostart-Eintrag entfernt'
}

# Läuft schon ein (alter) Server? Dann mit dem neuen Build neu starten.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $LauncherPs1 status *> $null
if ($LASTEXITCODE -eq 0) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $LauncherPs1 restart | Out-Null; Ok 'Laufender Server neu gestartet' }

# ── Fertig ─────────────────────────────────────────────────────────────────
Step 'Fertig'
Info "Starten:         Doppelklick auf »$AppName« auf dem Desktop / im Startmenü – oder »folio« in einem neuen Terminal"
Info "Adresse:         http://localhost:$Port"
Info 'Weitere Befehle: folio start | stop | restart | status | logs | update'
Info 'Deinstallieren:  install.cmd --uninstall'
Write-Host ''
