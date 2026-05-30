import { Client } from "@xhayper/discord-rpc";
import { log } from "./log.js";

const MIN_SET_INTERVAL_MS = 5000; // Discord allows ~5 SET_ACTIVITY / 20s; re-sends only on real changes
const MAX_BACKOFF_MS = 30000;
const IPC_TIMEOUT_MS = 8000;

// Bound an IPC promise so a hung Discord pipe can never freeze the poll loop. A late rejection is
// swallowed to avoid an unhandled rejection once the timeout has already won the race.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createPresence({ clientId }) {
  let client = null;
  let isConnected = false;
  let connecting = null;
  let backoffMs = 1000;
  let reconnectTimer = null;

  // Change-detect state. `contentKey` is the content/kind/text identity (a change → send immediately);
  // `fullKey` adds the playback anchor (a change with the same contentKey is just a seek → throttled).
  let lastFullKey = null;
  let lastContentKey = null;
  let lastSetAt = 0;
  let showing = false;

  function resetState() {
    lastFullKey = null;
    lastContentKey = null;
    showing = false;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = backoffMs;
    log.warn(`Discord RPC disconnected; reconnecting in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      connect().catch((err) => {
        log.debug(`Reconnect attempt failed: ${err.message}`);
        scheduleReconnect();
      });
    }, delay);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  function attachHandlers(c) {
    const onDrop = (reason) => {
      if (!isConnected && !connecting) return;
      isConnected = false;
      resetState();
      if (reason) log.debug(`Discord RPC event: ${reason}`);
      scheduleReconnect();
    };
    c.on("disconnected", () => onDrop("disconnected"));
    c.on("close", () => onDrop("close"));
    c.on("error", (err) => onDrop(`error: ${err?.message ?? err}`));
  }

  async function connect() {
    if (isConnected) return;
    if (connecting) return connecting;

    connecting = (async () => {
      if (client) {
        client.removeAllListeners?.();
        try {
          await client.destroy();
        } catch (err) {
          log.debug(`Error destroying stale client: ${err.message}`);
        }
        client = null;
      }
      client = new Client({ clientId });
      attachHandlers(client);
      await client.login();
      isConnected = true;
      backoffMs = 1000;
      log.success("Connected to Discord RPC");
    })();

    try {
      await connecting;
    } finally {
      connecting = null;
    }
  }

  // view = null clears presence. Otherwise:
  //   { details, state, largeUrl, largeText, smallUrl, smallText, startSec, endSec, buttons,
  //     contentKey, anchor, logLine }
  // We build the raw SET_ACTIVITY directly (the library's setActivity injects created_at, which the
  // Activity Card renders as a timer). For a "playing" view, pass startSec+endSec for a progress bar;
  // paused/buffering pass startSec only (elapsed, no bar); browsing passes neither.
  async function update(view) {
    if (!isConnected || !client) return;

    if (!view) {
      if (!showing) return;
      await withTimeout(client.user.clearActivity(), IPC_TIMEOUT_MS, "clearActivity");
      resetState();
      log.info("Presence cleared");
      return;
    }

    const fullKey = `${view.contentKey}|${view.anchor ?? ""}`;
    if (fullKey === lastFullKey) return; // nothing changed at all
    const contentChanged = view.contentKey !== lastContentKey;
    // A content/state change shows immediately; a same-content anchor change (a seek) is throttled so
    // heavy scrubbing can't trip Discord's rate limit. Steady playback keeps the same anchor → no send.
    if (!contentChanged && showing && Date.now() - lastSetAt < MIN_SET_INTERVAL_MS) return;

    const assets = {};
    if (view.largeUrl) {
      assets.large_image = view.largeUrl;
      assets.large_url = view.largeUrl;
    }
    if (view.largeText) assets.large_text = view.largeText;
    if (view.smallUrl) {
      assets.small_image = view.smallUrl;
      assets.small_url = view.smallUrl;
    }
    if (view.smallText) assets.small_text = view.smallText;

    const payload = { type: 3, instance: false };
    if (view.details) payload.details = view.details;
    if (view.state) payload.state = view.state;
    if (Object.keys(assets).length) payload.assets = assets;
    if (view.startSec != null) {
      payload.timestamps = { start: view.startSec };
      if (view.endSec != null) payload.timestamps.end = view.endSec;
    }
    if (view.buttons && view.buttons.length) payload.buttons = view.buttons.slice(0, 2);

    await withTimeout(
      client.request("SET_ACTIVITY", { pid: process.pid ?? 0, activity: payload }),
      IPC_TIMEOUT_MS,
      "setActivity",
    );
    lastFullKey = fullKey;
    lastContentKey = view.contentKey;
    lastSetAt = Date.now();
    showing = true;
    if (view.logLine) log.info(view.logLine);
  }

  async function stop() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (client) {
      try {
        if (isConnected && client.user && showing) {
          await withTimeout(client.user.clearActivity(), IPC_TIMEOUT_MS, "clearActivity");
        }
        await withTimeout(client.destroy(), IPC_TIMEOUT_MS, "destroy");
      } catch (err) {
        log.debug(`Error during presence stop: ${err.message}`);
      }
    }
    client = null;
    isConnected = false;
    resetState();
  }

  return {
    connect,
    update,
    clear: () => update(null),
    stop,
    get connected() {
      return isConnected;
    },
  };
}
