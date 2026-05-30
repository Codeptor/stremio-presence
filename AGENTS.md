# AGENTS.md — stremio-rpc

Background Node helper (Windows) that mirrors **what you're watching in Stremio 5** to your
**Discord profile** as a Rich Presence. Standalone process — NOT a Stremio addon (addons can't see
playback). See `HANDOFF.md` for the original research/scoping.

## Two playback sources (primary + fallback)

The helper reads playback from whichever source is available, preferring real-time:

### 1. CDP — real-time, primary (`src/cdp.js`)
Stremio 5 (`stremio-shell-ng.exe`) is a **Microsoft Edge WebView2** app that plays through **libmpv**
(there is NO `<video>` element, and the stremio-core JS `getState('player')` stays empty). When the
WebView2 is launched with a remote-debugging port, the helper attaches via the **Chrome DevTools
Protocol** and reads the live player state:
- **Position / pause / duration / eof**: raw libmpv property changes arrive in the renderer as
  `window.chrome.webview` `"message"` events, e.g. `{"args":["mpv-prop-change",{"name":"time-pos","data":2145.1}]}`.
  A one-time injected listener latches the latest values into `window.__rpc`. `time-pos` updates ~1 Hz;
  `pause`/`eof-reached` fire instantly on toggle.
- **What's playing**: parsed from the player route hash `#/player/<stream>/.../<type>/<imdbId>/<videoId>`
  (e.g. `series/tt30460310/tt30460310:1:1`). Off the `#/player/` route ⇒ player closed ⇒ clear.

**Latency ~1s; pause/stop instant; works for ALL stream types (torrent AND debrid/HTTP/direct).**
Requires the one-time setup below. Falls back to the cloud if the debug port isn't enabled.

### 2. Cloud library — fallback (`src/stremio.js`, `src/auth.js`, `src/detect.js`)
`api.strem.io` datastore (`datastoreMeta`/`datastoreGet`, collection `libraryItem`). Only updates the
playhead **~every 60–90s**, and pause/stop look identical (just stop-of-pushes). Used only when CDP is
unavailable. Detection (`detect.js`) requires the **playhead to actually advance** before showing a
title (so browsed/stale "Continue Watching" entries never show), and the orchestrator considers the
several freshest items so playback survives browsing another title.

## Architecture

```
                 src/index.js (orchestrator)  ── gated on stremio-shell-ng.exe (stremioProcess.js)
                 ├─ try CDP (real-time) ─────► src/cdp.js  ─CDP/ws→ WebView2 :9222 (libmpv events + route)
                 └─ else cloud (fallback) ───► src/stremio.js + src/auth.js + src/detect.js → api.strem.io
                          │
                          ▼  type/imdbId/videoId
                 src/cinemeta.js ──► v3-cinemeta.strem.io   (title, episode name, poster)
                          │
                          ▼
                 src/presence.js ──IPC─► Discord desktop (@xhayper/discord-rpc, raw SET_ACTIVITY)
```

- **src/index.js** — supervisor; ticks every 4s while Stremio is closed, polls CDP every 2s (or the
  cloud every `pollIntervalMs`) while open. Builds a **view** for each state (playing/paused/buffering/
  browsing) and hands it to `presence.update(view)`. Single-instance lock on loopback port `48757`.
  Watches `config.json` (hot-reload) and drives the tray.
- **src/cdp.js** — `createCdpSource().read()` → full route + live state: player
  `{onPlayer, type, imdbId, videoId, time(s), paused, duration(s), eof, buffering, stream:{source,quality}}`,
  or browse `{section, browse:{type,imdbId,videoId,query}}`, or `null` if the debug port is off. The stream
  source/quality is decoded from the route's deflate+base64 blob (zlib). Auto-reconnects.
- **src/presence.js** — `createPresence({clientId})`; one `update(view)` renderer for all states via **raw
  `client.request("SET_ACTIVITY")`** (the lib's `setActivity` injects `created_at` → an unwanted timer).
  Change detection: a content/state change sends immediately; a same-content anchor change (seek) throttles
  to ~5s; steady playback re-sends nothing (Discord's clock runs the timer). IPC wrapped in timeouts; backoff reconnect.
- **src/cinemeta.js** — `resolveMeta(type, id, videoId)` → title/subtitle/poster/imdbId (in-memory cache).
- **src/tray.js** — `createTray()` system-tray icon (systray2) with live status + Open config/folder/Quit;
  no-op if it can't start. **src/log/config/stremioProcess** — logging, config (+env overrides + hot-reload), process gate.

## Verified facts (confirmed live — do not re-assume)

- **CDP is the real-time signal** for Stremio 5; the streaming server (`:11471`) is a dead end (the
  position never leaves the renderer for in-app playback) and `getState('player')` is empty in v5.
- **Units: CDP `time`/`duration` are SECONDS; cloud `timeOffset`/`duration` are MILLISECONDS.** Don't
  double-scale. Discord wants UNIX seconds → `startTimestamp = nowSec - playheadSec`.
- **Discord's redesigned Activity Cards always render a moving time element** on a visible media card —
  there is no "frozen timer" payload. So the paused card shows the elapsed time (no progress bar) + a
  pause badge; the timer can't be frozen (Discord limitation, not a data one). `clearActivity()`+`setActivity()`
  to swap states makes the card vanish (presence throttle) — never do it; one SET_ACTIVITY per transition.
- **External images**: put the raw `https` URL in `large_image`/`small_image` (Discord auto-proxies); the
  `large_url`/`small_url` fields are ignored over IPC. Poster from `images.metahub.space` (redirect is fine).
- **authKey (cloud fallback)**: in Stremio 5's WebView2 localStorage (`profile` → `auth.key`); see
  `src/auth.js`. Stored Latin1/UTF-8, files EBUSY while Stremio runs (copy first).

## One-time setup (enables real-time)

Enable the WebView2 debug port, then relaunch Stremio:
```
[Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','--remote-debugging-port=9222 --remote-allow-origins=*','User')
```
- Both flags are mandatory: the port enables CDP; `--remote-allow-origins=*` avoids the Edge 111+ WebSocket
  403. The port binds `127.0.0.1` only — no network exposure.
- This env var is **global to all WebView2 apps**. To scope it to Stremio only, set a REG_SZ named
  `stremio-shell-ng.exe` under `HKCU\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`
  (needs admin/policy access — was denied on this machine, hence the env-var route).
- Without this, the helper still works via the cloud fallback (slower; ~60–90s, no instant pause/stop).

## Conventions

- Node 24, ESM, native `fetch`. Deps: `@xhayper/discord-rpc`, `ws` (CDP transport). ANSI codes for color.
- Throw with context; no silent fallbacks. Comments only for non-obvious *why*.
- `auth.json` is gitignored (holds the cloud authKey). Never commit it or log the key.

## Run

```
node src/index.js          # DEBUG=1 for verbose
```
Silent autostart: `scripts/install-autostart.ps1` (Startup shortcut → `scripts/start-hidden.vbs`).

## Known notes

- CDP `duration` is captured only if the helper's hook is installed before playback starts (mid-play
  attach misses the one-shot `duration` prop) — then the playing card shows elapsed only (no bar) until
  the next video. Position/pause are always live.
- Two Stremio installs on this box: v4.4 (`Smart Code ltd\Stremio`, Qt) and v5 beta (`StremioService`,
  WebView2). CDP + auth target the v5 beta WebView2.
