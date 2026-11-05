@echo off
rem Folio - Installer fuer Windows (startet install.ps1, Optionen siehe: install.cmd --help)
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "rc=%ERRORLEVEL%"
rem Per Doppelklick gestartet? Dann Fenster offen lassen, damit die Ausgabe lesbar bleibt.
for %%x in (%cmdcmdline%) do if /i "%%~x"=="/c" (
  echo.
  pause
  goto :done
)
:done
exit /b %rc%
