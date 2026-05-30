# stremio-presence

**Real-time Discord Rich Presence for Stremio 5.** While Stremio is open and you
are watching something, your Discord profile shows the title, poster, episode,
quality, and a synced timeline — updating live (exact position, instant
pause/stop). When you pause or quit Stremio, the presence clears itself.

No login. No password. The helper reads your existing Stremio session straight
out of the local Stremio app — and, in real-time mode, reads the live player
directly. Windows only (it talks to the Discord and Stremio desktop apps).

> **Why "real-time"?** Stremio's cloud only syncs your position every ~60–90s,
> so most presence tools lag badly. This one taps Stremio 5's WebView2/libmpv
> player locally for ~1-second-accurate position and instant pause/stop, and
> falls back to the cloud automatically if you don't enable it.

---

## What it does

- **Real-time mode (recommended):** reads the live libmpv playhead straight from
  Stremio 5's renderer via the WebView2 DevTools protocol — **exact position,
  ~1s fresh, instant pause/stop**, and works for every stream type (torrent and
  debrid/direct). Needs the one-time setup below.
- **Cloud fallback:** if real-time mode isn't enabled, it polls your Stremio
  library via `api.strem.io` and infers playing/paused by watching the playhead
  advance. Works without any setup, but Stremio only syncs the position every
  ~60–90s, so it lags and can't tell pause from stop instantly.
- Resolves metadata (title, season + episode + episode name, poster art) from
  Cinemeta and pushes a `Watching` activity to Discord (synced timeline +
  **View on IMDb** / **Open in Stremio** buttons).
- **Quality badge** — shows the stream quality/source (e.g. `4K · HDR`, Torrentio)
  when in real-time mode. **Buffering** is shown while the stream loads.
- **Rich idle state** — when you're not watching, shows **what you're browsing**
  (the title's detail page, *Searching “…”*, *Browsing Discover*, etc.).
- **System tray icon** — live status (▶ / ⏸ / Browsing) with *Open config* /
  *Open folder* / *Quit*.
- **Config hot-reload** — edits to `config.json` apply live (no restart).
- **Gated on the Stremio process**: presence only exists while the Stremio
  desktop app is running, and is torn down the moment it quits.

---

## Prerequisites

- **Node.js 24+** (uses native global `fetch` and ES modules).
- **Discord desktop app** running and logged in (the Rich Presence IPC pipe
  lives in the desktop client — the browser version will not work).
- **Stremio 5 (beta) desktop app** installed, logged in, and running. The auth
  key is read from Stremio's local WebView2 store, so you must have signed in to
  Stremio at least once on this machine.

Install dependencies once:

```sh
npm install
```

Dependencies: `@xhayper/discord-rpc` (Discord IPC), `ws` (CDP transport), and
`systray2` (tray icon).

Then create your config from the template:

```sh
cp config.example.json config.json
```

`config.json` is gitignored, so your settings (and Discord Client ID) stay local.

---

## Real-time mode (recommended)

For exact position + instant pause/stop, enable Stremio's WebView2 debug port so
the helper can read the live player. Run this once (PowerShell, no admin), then
**fully quit and relaunch Stremio**:

```powershell
[Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','--remote-debugging-port=9222 --remote-allow-origins=*','User')
```

- Both flags are required (`--remote-allow-origins=*` avoids an Edge WebSocket
  403). The port binds to `127.0.0.1` only — **no network exposure**.
- This env var applies to all WebView2 apps. To scope it to Stremio only (admin),
  set a `REG_SZ` named `stremio-shell-ng.exe` under
  `HKCU\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`.
- **Undo:** clear the env var:
  `[Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',$null,'User')`.

Skip this and the helper still runs via the cloud fallback (slower). The log line
`Real-time playback source active (CDP)` confirms real-time mode is on.

---

## One-time setup: create a Discord application

The presence needs its own Discord application so it has a client ID and a place
to host art assets.

1. Go to <https://discord.com/developers/applications> and click
   **New Application**. Name it whatever you want (e.g. `Stremio`) — this name
   is what shows above the activity in your profile.
2. On the **General Information** page, copy the **Application ID**.
3. Open `config.json` in the repo root and paste it into `discordClientId`,
   replacing the `YOUR_DISCORD_APP_ID` placeholder:

   ```json
   {
     "discordClientId": "123456789012345678"
   }
   ```

4. *(Optional but recommended)* In the left sidebar open **Rich Presence →
   Art Assets** and upload a small square image named exactly **`stremio`**.
   Then set `smallImageUrl` in `config.json` to a direct image URL (or leave it
   blank to skip the small badge). The large image is always the title's poster,
   pulled live from Cinemeta, so you don't need to upload posters.

That is the entire Discord-side setup. You do **not** need a bot token, OAuth
redirect, or any scopes — Rich Presence works purely over the local Discord
client.

---

## How auth works (zero-login)

There is no email/password prompt and no password is ever stored.

On first run the helper:

1. Locates Stremio 5's WebView2 LevelDB store under
   `…\StremioService\stremio-shell-ng.exe.WebView2\EBWebView\Default\Local Storage\leveldb`.
2. Because Stremio keeps those files locked while it runs, it copies them to a
   temp directory, then scans them for your saved session and extracts the auth
   key.
3. Writes just that key to `auth.json` in the repo root so subsequent runs are
   instant and don't need to touch Stremio's files again.

If `auth.json` already holds a valid key, that is used directly. If the key ever
expires, the helper refreshes it from the Stremio store automatically on the
next API call. As a fallback only, if `STREMIO_EMAIL` and `STREMIO_PASSWORD`
environment variables are set, it can log in with those — but the normal path
never reads or stores a password.

> `auth.json` contains a live session key for your Stremio account. Treat it
> like a credential — don't commit it or share it.

---

## Running it

```sh
node src/index.js
```

(or `npm start`). Leave it running in the background. Expected lifecycle:

- **Stremio closed** → the helper idles, checking every few seconds for Stremio
  to launch. No Discord connection, no API polling.
- **Stremio open** → it connects to Discord and polls your library every
  `pollIntervalMs`. Start watching something and the presence appears within a
  poll cycle.
- **Paused / idle / browsing** → presence clears (it only shows while playback
  is actually progressing).
- **Stremio quits** → the Discord presence is removed immediately.
- **Ctrl+C** → clears the presence, disconnects, and exits cleanly.

Set the `DEBUG` environment variable for verbose logging.

---

## Configuration (`config.json`)

Edits apply live (hot-reload) — no restart needed, except a `discordClientId` change.

| Key                 | Default              | Meaning |
|---------------------|----------------------|---------|
| `discordClientId`   | `YOUR_DISCORD_APP_ID`| Your Discord Application ID. Required — presence stays off until set. |
| `pollIntervalMs`    | `15000`              | Cloud-fallback poll interval (ms). Real-time mode polls every 2s. |
| `staleSeconds`      | `150`                | Cloud fallback: a title with no playhead advance for this long → not playing. |
| `pausedMaxSeconds`  | `180`                | Cloud fallback: how long a paused title keeps showing before it clears. |
| `posterSize`        | `medium`             | Cinemeta poster size: `small`, `medium`, or `large`. |
| `smallImageUrl`     | URL                  | Small badge image (the Stremio logo). Blank = none. |
| `showImdbButton`    | `true`               | Show the **View on IMDb** button. |
| `showStremioButton` | `true`               | Show the **Open in Stremio** button. |
| `showQuality`       | `true`               | Append the stream quality/source (e.g. `4K · HDR`). Real-time only. |
| `showBrowsing`      | `true`               | Show a rich idle state (what you're browsing) when not watching. |
| `showTray`          | `true`               | Show the system tray icon. |

Environment overrides: `DISCORD_CLIENT_ID`, `POLL_INTERVAL_MS`, `STALE_SECONDS`
take precedence over the file values.

---

## Silent autostart (recommended — presence appears automatically)

So presence "just works" without ever running `node` by hand, the helper runs
**resident**: launched silently at login, idle (a cheap process check, no Discord,
no API) while Stremio is closed, and showing presence automatically once you start
playing. A single-instance lock (loopback port 48757) prevents duplicate copies.

**One-step install** (creates the Startup shortcut *and* launches it now):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

That registers `scripts\start-hidden.vbs` (which runs `node src\index.js` hidden)
in your per-user Startup folder, so it auto-starts at every login.

> **Note on timing:** "automatically on playback" means **~1 minute after you start
> playing**, not instant. Stremio only syncs the playhead to its cloud library every
> ~60–90 s, and that cloud value is the only clean source of title + episode +
> position on the official v5 app — so the first presence update lands after Stremio's
> first push. The elapsed timer is then accurate (it's anchored to the real playhead).

**Stop / uninstall:**

- Stop the running helper: end the `node.exe` whose command line is `src\index.js`
  (it's the process listening on `127.0.0.1:48757`), or just close Stremio (it goes
  idle) — though the resident process stays up to catch the next session.
- Remove autostart: delete
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\stremio-rpc.lnk`.
