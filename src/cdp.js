import http from "node:http";
import zlib from "node:zlib";
import WebSocket from "ws";
import { log } from "./log.js";

// Real-time playback + navigation reader for Stremio 5 (official) via the WebView2 Chrome DevTools
// Protocol. Stremio 5 plays through libmpv (no <video> element; stremio-core getState is empty), so
// the live signal is the raw mpv property stream the shell pushes as window.chrome.webview "message"
// events. We latch the latest props into window.__rpc and read the route hash for what's on screen.
// Requires the WebView2 host launched with --remote-debugging-port=9222 --remote-allow-origins=*.

const HOST = "127.0.0.1";
const PORT = 9222;

const SETUP_EXPR = `(() => {
  if (window.__rpcHooked) return "ok";
  window.__rpc = {};
  const h = (e) => {
    try {
      const d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      const a = d && d.args;
      if (a && a[0] === "mpv-prop-change" && a[1]) {
        const n = a[1].name, v = a[1].data;
        if (n === "time-pos") { window.__rpc.time = v; window.__rpc.eof = false; }
        else if (n === "pause") window.__rpc.paused = v;
        else if (n === "duration") window.__rpc.duration = v;
        else if (n === "eof-reached") window.__rpc.eof = v;
        else if (n === "paused-for-cache") window.__rpc.cache = v; // cache underrun mid-playback
        else if (n === "seeking") window.__rpc.seeking = v; // loading after a (long) seek
      }
    } catch (_) {}
  };
  window.chrome.webview.addEventListener("message", h);
  window.__rpcHooked = true;
  return "ok";
})()`;

// Parses the route hash into a structured view. Player route: #/player/<streamBlob>/.../<type>/<imdbId>/<videoId>.
// Browse routes: #/detail/<type>/<imdbId>[/<videoId>], #/search?search=<q>, #/discover/..., #/library/..., #/, ...
const READ_EXPR = `(() => {
  const h = location.hash || "";
  const qi = h.indexOf("?");
  const pathPart = (qi >= 0 ? h.slice(0, qi) : h).replace(/^#\\/?/, "");
  const query = qi >= 0 ? h.slice(qi + 1) : "";
  const segs = pathPart.split("/").filter(Boolean);
  const section = segs[0] || "home";
  const dec = (x) => { try { return decodeURIComponent(x || ""); } catch (_) { return x || null; } };
  const r = window.__rpc || (window.__rpc = {});

  if (section === "player") {
    const type = segs[segs.length - 3] || null;
    const imdbId = segs[segs.length - 2] || null;
    const videoId = dec(segs[segs.length - 1]);
    // On a content switch the latched values belong to the old file until the new props arrive.
    if (videoId !== r.vid) { r.vid = videoId; r.time = null; r.seeking = false; r.cache = false; }
    return JSON.stringify({
      section: "player", onPlayer: true, type, imdbId, videoId,
      streamBlob: segs[1] ? dec(segs[1]) : null,
      time: r.time != null ? r.time : null,
      paused: typeof r.paused === "boolean" ? r.paused : null,
      duration: r.duration != null ? r.duration : null,
      eof: r.eof === true,
      buffering: r.cache === true || r.seeking === true,
    });
  }

  r.vid = null; // left the player
  let bType = null, bImdb = null, bVideo = null, q = null;
  if (section === "detail") { bType = segs[1] || null; bImdb = segs[2] || null; bVideo = dec(segs[3]) || null; }
  else if (section === "search") { try { const sp = new URLSearchParams(query); q = sp.get("search") || sp.get("query"); } catch (_) {} }
  else if (section === "discover" || section === "library") { bType = segs[2] || segs[1] || null; }
  return JSON.stringify({ section, onPlayer: false, browse: { type: bType, imdbId: bImdb, videoId: bVideo, query: q } });
})()`;

// Decode the deflate+base64 stream blob from the player route → { source, quality }.
const streamCache = new Map();
function decodeStream(blob) {
  if (!blob) return null;
  if (streamCache.has(blob)) return streamCache.get(blob);
  let info = null;
  try {
    const raw = Buffer.from(blob, "base64");
    let json = null;
    for (const fn of [zlib.inflateSync, zlib.inflateRawSync, zlib.gunzipSync]) {
      try { json = fn(raw).toString("utf8"); break; } catch (_) {}
    }
    if (json) info = parseStreamInfo(JSON.parse(json));
  } catch (_) {}
  if (streamCache.size > 64) streamCache.clear();
  streamCache.set(blob, info);
  return info;
}

function parseStreamInfo(stream) {
  const name = String(stream.name || stream.title || "");
  const text = `${name} ${stream.description || ""} ${stream.behaviorHints?.filename || ""}`;
  const source = name.split("\n")[0].replace(/\[[^\]]*\]/g, "").trim() || null;
  const tags = [];
  if (/\b(2160p|4k|uhd)\b/i.test(text)) tags.push("4K");
  else if (/\b1080p\b/i.test(text)) tags.push("1080p");
  else if (/\b720p\b/i.test(text)) tags.push("720p");
  else if (/\b480p\b/i.test(text)) tags.push("480p");
  if (/\bdolby.?vision\b|\bdovi\b|(?<![a-z])dv(?![a-z])/i.test(text)) tags.push("DV");
  if (/\bhdr10?\+?\b|\bhdr\b/i.test(text)) tags.push("HDR");
  return { source: source || null, quality: tags.join(" ") || null };
}

export function createCdpSource() {
  let ws = null;
  let connected = false;
  let msgId = 0;
  const pending = new Map();

  function getJSON(path) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: HOST, port: PORT, path, timeout: 3000 }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("CDP HTTP timeout")));
    });
  }

  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("CDP socket not open"));
      const id = ++msgId;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 5000);
      if (typeof timer.unref === "function") timer.unref();
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function teardown() {
    connected = false;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP disconnected"));
    }
    pending.clear();
    if (ws) {
      try { ws.removeAllListeners(); ws.close(); } catch (_) {}
      ws = null;
    }
  }

  async function connectOnce() {
    const targets = await getJSON("/json");
    const page = targets.find((t) => t.type === "page" && /web\.stremio\.com/.test(t.url));
    if (!page || !page.webSocketDebuggerUrl) throw new Error("no web.stremio.com page target");

    ws = new WebSocket(page.webSocketDebuggerUrl, { origin: "http://localhost", perMessageDeflate: false });
    ws.on("message", (data) => {
      let m;
      try { m = JSON.parse(data); } catch (_) { return; }
      const p = m.id != null && pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    // Handshake succeeded — attach the permanent lifecycle handlers now (so they don't overlap the
    // one-shot error listener above and double-teardown on a failed connect).
    ws.on("close", teardown);
    ws.on("error", teardown);
    await rpc("Runtime.enable");
    await rpc("Runtime.evaluate", { expression: SETUP_EXPR, returnByValue: true });
    connected = true;
    log.debug("CDP connected to Stremio renderer");
  }

  // Returns the live state, or null when CDP is unavailable (debug port off).
  async function read() {
    if (!connected) {
      try {
        await connectOnce();
      } catch (err) {
        teardown();
        log.debug(`CDP unavailable: ${err.message}`);
        return null;
      }
    }
    try {
      const r = await rpc("Runtime.evaluate", { expression: READ_EXPR, returnByValue: true });
      const state = JSON.parse(r.result.value);
      if (state.onPlayer) state.stream = decodeStream(state.streamBlob);
      return state;
    } catch (err) {
      teardown();
      log.debug(`CDP read failed: ${err.message}`);
      return null;
    }
  }

  function stop() {
    teardown();
  }

  return {
    read,
    stop,
    get connected() {
      return connected;
    },
  };
}
