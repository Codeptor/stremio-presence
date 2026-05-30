import net from "node:net";
import { watch } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config, reloadConfig, configPath } from "./config.js";
import { log } from "./log.js";
import { isStremioRunning } from "./stremioProcess.js";
import { datastoreMeta, datastoreGet } from "./stremio.js";
import { createDetector } from "./detect.js";
import { resolveMeta } from "./cinemeta.js";
import { createPresence } from "./presence.js";
import { createCdpSource } from "./cdp.js";
import { createTray } from "./tray.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// explorer.exe opens a file with its default app or a folder in Explorer; no shell, no interpolation.
const openPath = (p) => execFile("explorer.exe", [p], () => {});

const CLOSED_TICK_MS = 4000; // process check cadence while Stremio is closed
const CDP_POLL_MS = 2000; // real-time source poll cadence (local + cheap)
const CANDIDATES = 6; // cloud-fallback: how many freshest items to consider
const STALL_MS = 1900; // playhead not advancing this long (while not paused) ⇒ buffering

const PAUSE_ICON_URL = "https://img.icons8.com/color/512/pause.png";
const BUFFER_ICON_URL = "https://img.icons8.com/fluency/512/loading.png";

const SINGLE_INSTANCE_PORT = 48757;
const instanceLock = net.createServer();

function acquireSingleInstanceLock() {
  return new Promise((resolve) => {
    instanceLock.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        log.warn("Another stremio-rpc instance is already running — exiting.");
        process.exit(0);
      }
      log.error(`Single-instance lock failed: ${err.message}`);
      process.exit(1);
    });
    instanceLock.listen(SINGLE_INSTANCE_PORT, "127.0.0.1", () => {
      instanceLock.unref();
      resolve();
    });
  });
}

const detector = createDetector({
  staleSeconds: config.staleSeconds,
  pausedMaxSeconds: config.pausedMaxSeconds,
});
let presence = createPresence({ clientId: config.discordClientId });
const cdp = createCdpSource();
let tray = { setStatus() {}, destroy() {} };

// Hot-reload config.json: most options apply on the next tick (read live); a Discord Client ID change
// recreates the presence client so it reconnects with the new app.
function watchConfig() {
  let timer = null;
  try {
    watch(configPath, () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const { ok, clientIdChanged } = reloadConfig();
        if (!ok) return;
        log.info("config.json reloaded.");
        if (clientIdChanged) {
          try {
            await presence.stop();
          } catch (err) {
            log.debug(`presence stop on client-id change failed: ${err.message}`);
          }
          presence = createPresence({ clientId: config.discordClientId });
        }
      }, 400);
    });
  } catch (err) {
    log.debug(`config watch unavailable: ${err.message}`);
  }
}

let running = true;
let wasRunning = null;
let cdpActive = null;
let lastPlayheadSec = -1;
let lastAdvanceMs = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CDP only emits libmpv `duration` once at file load; attaching mid-playback misses it. The cloud
// library item always carries the exact duration (ms) once watched — cached per video.
const durationCache = new Map();
async function cloudDurationMs(imdbId, videoId) {
  if (!imdbId) return 0;
  if (durationCache.has(videoId)) return durationCache.get(videoId);
  try {
    const items = await datastoreGet([imdbId]);
    const st = items?.[0]?.state;
    if (st && st.duration > 0 && (!st.video_id || !videoId || st.video_id === videoId)) {
      durationCache.set(videoId, st.duration);
      return st.duration;
    }
  } catch (err) {
    log.debug(`cloud duration lookup failed (${imdbId}): ${err.message}`);
  }
  return 0;
}

async function resolveSafe(type, id, videoId) {
  try {
    return await resolveMeta(type, id, videoId);
  } catch (err) {
    log.debug(`Cinemeta lookup failed (${id}): ${err.message}`);
    return {
      title: id || "Stremio",
      subtitle: null,
      posterUrl: null,
      imdbId: /^tt\d/.test(id || "") ? id : null,
    };
  }
}

function titleButtons(type, imdbId) {
  const buttons = [];
  if (config.showImdbButton && /^tt\d/.test(imdbId || "")) {
    buttons.push({ label: "View on IMDb", url: `https://www.imdb.com/title/${imdbId}/` });
  }
  if (config.showStremioButton && imdbId) {
    buttons.push({ label: "Open in Stremio", url: `https://web.stremio.com/#/detail/${type}/${encodeURIComponent(imdbId)}` });
  }
  return buttons.length ? buttons : null;
}

// Build a playing/paused/buffering view from a position (seconds) + metadata.
function playbackView({ resolved, type, timeSec, durSec, nowMs, paused, buffering, source, quality }) {
  const startSec = Math.floor(nowMs / 1000) - timeSec;
  let stateLine = resolved.subtitle || null;
  if (config.showQuality && quality) stateLine = stateLine ? `${stateLine} · ${quality}` : quality;

  let smallUrl, smallText;
  if (buffering) {
    smallUrl = BUFFER_ICON_URL;
    smallText = "Buffering…";
  } else if (paused) {
    smallUrl = PAUSE_ICON_URL;
    smallText = "Paused";
  } else {
    smallUrl = config.smallImageUrl || null;
    smallText = source || "Stremio";
  }

  const kind = buffering ? "buffering" : paused ? "paused" : "playing";
  return {
    details: resolved.title,
    state: stateLine,
    largeUrl: resolved.posterUrl,
    largeText: resolved.title,
    smallUrl,
    smallText,
    startSec,
    endSec: paused || buffering ? null : durSec ? startSec + durSec : null,
    buttons: titleButtons(type, resolved.imdbId),
    contentKey: [resolved.title, stateLine, resolved.posterUrl, kind].join("|"),
    anchor: paused || buffering ? `f${timeSec}` : `s${Math.round(startSec / 3)}`,
    logLine: `${kind === "playing" ? "▶" : kind === "paused" ? "⏸" : "⟳"} ${resolved.title}${stateLine ? ` — ${stateLine}` : ""}`,
  };
}

async function viewFromCdp(live, nowMs) {
  if (live.onPlayer) {
    if (live.eof) return null;
    const resolved = await resolveSafe(live.type, live.imdbId, live.videoId);
    if (live.time == null) {
      // In the player but no playhead yet (initial load / buffering before the first frame). Show a
      // loading card instead of clearing the presence.
      return {
        details: resolved.title,
        state: "Loading…",
        largeUrl: resolved.posterUrl,
        largeText: resolved.title,
        smallUrl: BUFFER_ICON_URL,
        smallText: "Loading…",
        startSec: null,
        endSec: null,
        buttons: titleButtons(live.type, resolved.imdbId),
        contentKey: `loading|${live.videoId}`,
        anchor: "",
        logLine: `⟳ Loading ${resolved.title}`,
      };
    }
    let durSec = live.duration ? Math.round(live.duration) : 0;
    if (!durSec) {
      const ms = await cloudDurationMs(live.imdbId, live.videoId);
      durSec = ms ? Math.round(ms / 1000) : 0;
    }
    const timeSec = Math.floor(live.time);
    // Stall-based buffering: if the playhead isn't advancing while not paused, it's buffering. Covers
    // seeks and cache underruns regardless of which mpv prop fired (seeking is too brief to catch).
    if (timeSec !== lastPlayheadSec) {
      lastPlayheadSec = timeSec;
      lastAdvanceMs = nowMs;
    }
    const stalled = live.paused !== true && nowMs - lastAdvanceMs > STALL_MS;
    return playbackView({
      resolved,
      type: live.type,
      timeSec,
      durSec,
      nowMs,
      paused: live.paused === true,
      buffering: (live.buffering === true || stalled) && live.paused !== true,
      source: live.stream?.source,
      quality: live.stream?.quality,
    });
  }

  // Not on the player — show what's being browsed (idle state).
  if (!config.showBrowsing) return null;
  const b = live.browse || {};
  if (live.section === "detail" && b.imdbId) {
    const resolved = await resolveSafe(b.type, b.imdbId, b.videoId || b.imdbId);
    if (resolved.title && resolved.title !== b.imdbId) {
      return {
        details: resolved.title,
        state: "Browsing on Stremio",
        largeUrl: resolved.posterUrl || config.smallImageUrl || null,
        largeText: resolved.title,
        smallUrl: config.smallImageUrl || null,
        smallText: "Stremio",
        startSec: null,
        endSec: null,
        buttons: titleButtons(b.type, resolved.imdbId),
        contentKey: `browse-detail|${b.imdbId}`,
        anchor: "",
        logLine: `· Browsing ${resolved.title}`,
      };
    }
  }
  const labels = {
    search: b.query ? `Searching “${b.query}”` : "Searching",
    discover: "Browsing Discover",
    library: "Browsing Library",
    addons: "Browsing add-ons",
    settings: "In settings",
    calendar: "Browsing Calendar",
  };
  const state = labels[live.section] || "Browsing Stremio";
  return {
    details: "Stremio",
    state,
    largeUrl: config.smallImageUrl || null,
    largeText: "Stremio",
    smallUrl: null,
    smallText: null,
    startSec: null,
    endSec: null,
    buttons: null,
    contentKey: `browse-${live.section}|${b.query || ""}`,
    anchor: "",
    logLine: `· ${state}`,
  };
}

async function viewFromCloud(nowMs) {
  const meta = await datastoreMeta();
  if (!Array.isArray(meta) || meta.length === 0) return null;
  const top = meta
    .filter((e) => Array.isArray(e) && e.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, CANDIDATES);
  if (top.length === 0) return null;

  const items = await datastoreGet(top.map((e) => e[0]));
  const byId = new Map(items.map((it) => [it._id, it]));
  let chosen = null;
  let chosenStatus = "idle";
  for (const [id] of top) {
    const item = byId.get(id);
    if (!item) continue;
    const { status } = detector.classify({ id, state: item.state, nowMs });
    if (status === "playing" && chosenStatus !== "playing") {
      chosen = item;
      chosenStatus = "playing";
    } else if (status === "paused" && chosenStatus === "idle") {
      chosen = item;
      chosenStatus = "paused";
    }
  }
  if (!chosen) return null;

  const resolved = await resolveSafe(chosen.type, chosen._id, chosen.state.video_id);
  return playbackView({
    resolved,
    type: chosen.type,
    timeSec: Math.floor((chosen.state.timeOffset || 0) / 1000),
    durSec: chosen.state.duration ? Math.round(chosen.state.duration / 1000) : 0,
    nowMs,
    paused: chosenStatus === "paused",
    buffering: false,
    source: null,
    quality: null,
  });
}

async function tick() {
  if (!(await isStremioRunning())) {
    if (presence.connected) await presence.stop();
    cdp.stop();
    detector.reset();
    cdpActive = null;
    tray.setStatus("Stremio not running");
    if (wasRunning !== false) {
      log.info("Stremio not running — idle.");
      wasRunning = false;
    }
    return CLOSED_TICK_MS;
  }

  if (wasRunning !== true) {
    log.info("Stremio is running.");
    wasRunning = true;
  }
  if (!presence.connected) await presence.connect();

  const nowMs = Date.now();

  const live = await cdp.read();
  if (live !== null) {
    if (cdpActive !== true) {
      log.success("Real-time playback source active (CDP).");
      cdpActive = true;
    }
    const view = await viewFromCdp(live, nowMs);
    await presence.update(view);
    tray.setStatus(view ? view.logLine.replace(/^·\s*/, "") : "Idle in Stremio");
    return CDP_POLL_MS;
  }
  if (cdpActive !== false) {
    log.info("CDP debug port not available — using cloud library (slower). See README to enable real-time.");
    cdpActive = false;
  }
  const view = await viewFromCloud(nowMs);
  await presence.update(view);
  tray.setStatus(view ? view.logLine.replace(/^·\s*/, "") : "Idle in Stremio");
  return config.pollIntervalMs;
}

async function mainLoop() {
  while (running) {
    let delay = config.pollIntervalMs;
    try {
      delay = await tick();
    } catch (err) {
      log.warn(`Tick error: ${err.message}`);
      delay = config.pollIntervalMs;
    }
    if (!running) break;
    await sleep(delay);
  }
}

async function shutdown(signal) {
  if (!running) return;
  running = false;
  log.info(`Received ${signal}, shutting down.`);
  try {
    tray.destroy();
    cdp.stop();
    await presence.stop();
  } catch (err) {
    log.warn(`Error during shutdown: ${err.message}`);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  await acquireSingleInstanceLock();
  watchConfig();
  if (config.showTray) {
    tray = await createTray({
      onQuit: () => shutdown("tray quit"),
      onOpenConfig: () => openPath(configPath),
      onOpenFolder: () => openPath(ROOT),
    });
  }
  log.success("stremio-rpc started.");
  await mainLoop();
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
