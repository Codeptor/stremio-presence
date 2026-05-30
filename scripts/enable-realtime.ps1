# enable-realtime.ps1 — turns on Stremio 5 real-time mode for stremio-rpc.
#
# It adds a WebView2 remote-debugging port so the helper can read the live libmpv playhead (exact
# position, instant pause/stop) instead of the slower cloud library. The port binds to 127.0.0.1
# only — no network exposure. No admin required. Run once, then FULLY QUIT and relaunch Stremio.
#
# Undo:  [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',$null,'User')
$ErrorActionPreference = 'Stop'

$value = '--remote-debugging-port=9222 --remote-allow-origins=*'
[Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', $value, 'User')

Write-Host "[+] Real-time mode enabled (User env var):" -ForegroundColor Green
Write-Host "    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $value"
Write-Host ""
Write-Host "[!] Now FULLY QUIT Stremio (tray included) and relaunch it for this to take effect." -ForegroundColor Yellow
Write-Host "    The debug port binds to 127.0.0.1 only. This env var applies to all WebView2 apps;"
Write-Host "    the helper still works without it (via the slower cloud fallback)."
