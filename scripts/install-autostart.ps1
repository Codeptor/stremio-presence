# install-autostart.ps1 — registers stremio-rpc to start silently at login and launches it now.
# The helper is resident but idle (just a cheap process check) while Stremio is closed; it connects
# to Discord and shows presence only while Stremio is running. Re-run any time (idempotent).
# Uninstall: delete "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\stremio-rpc.lnk".
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$vbs  = Join-Path $PSScriptRoot 'start-hidden.vbs'
if (-not (Test-Path $vbs)) { throw "start-hidden.vbs not found at $vbs" }

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'stremio-rpc.lnk'

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($lnkPath)
$lnk.TargetPath       = $wscript
$lnk.Arguments        = '"' + $vbs + '"'
$lnk.WorkingDirectory = $repo
$lnk.WindowStyle      = 7
$lnk.Description       = 'Stremio Discord Rich Presence'
$lnk.Save()
Write-Host "[+] Startup shortcut created: $lnkPath"

# Launch now so presence works this session without waiting for the next login.
# The single-instance lock in src/index.js prevents duplicate instances.
Start-Process -FilePath $wscript -ArgumentList ('"' + $vbs + '"')
Write-Host "[+] Resident helper launched (hidden). It will show presence ~1 min after you start playing."
