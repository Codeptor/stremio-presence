import { readFile, writeFile, readdir, copyFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

const AUTH_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "auth.json");
const LEVELDB_DIR = join(
  homedir(),
  "AppData/Local/Programs/StremioService/stremio-shell-ng.exe.WebView2/EBWebView/Default/Local Storage/leveldb",
);
const LOGIN_URL = "https://api.strem.io/api/login";

// The leading quote of the "auth" JSON key is not reliably present on disk:
// LevelDB snappy-frames the localStorage value, so the byte preceding `auth`
// is a length prefix, not a double-quote. Match from `auth":{"key":"` onward.
const AUTH_KEY_MARKER = 'auth":{"key":"';

async function readCachedKey() {
  if (!existsSync(AUTH_FILE)) return null;
  let raw;
  try {
    raw = await readFile(AUTH_FILE, "utf8");
  } catch (err) {
    throw new Error(`failed to read auth cache at ${AUTH_FILE}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`auth cache at ${AUTH_FILE} is not valid JSON: ${err.message}`);
  }
  const key = parsed?.authKey;
  if (typeof key === "string" && key.length > 0) return key;
  return null;
}

async function cacheKey(authKey) {
  try {
    await writeFile(AUTH_FILE, JSON.stringify({ authKey }, null, 2), "utf8");
  } catch (err) {
    throw new Error(`failed to write auth cache at ${AUTH_FILE}: ${err.message}`);
  }
}

function extractPrintableRuns(buf, encoding) {
  const decoded = buf.toString(encoding);
  const runs = [];
  let current = "";
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      current += decoded[i];
    } else if (current.length > 0) {
      runs.push(current);
      current = "";
    }
  }
  if (current.length > 0) runs.push(current);
  return runs.join("\n");
}

function findAuthKeyInText(text) {
  const start = text.indexOf(AUTH_KEY_MARKER);
  if (start === -1) return null;
  const valueStart = start + AUTH_KEY_MARKER.length;
  const valueEnd = text.indexOf('"', valueStart);
  if (valueEnd === -1) return null;
  const key = text.slice(valueStart, valueEnd);
  if (key.length === 0) return null;
  return key;
}

async function extractFromLevelDb() {
  if (!existsSync(LEVELDB_DIR)) {
    throw new Error(
      `Stremio WebView2 LevelDB directory not found at ${LEVELDB_DIR} (is StremioService installed?)`,
    );
  }

  let entries;
  try {
    entries = await readdir(LEVELDB_DIR);
  } catch (err) {
    throw new Error(`failed to list LevelDB directory ${LEVELDB_DIR}: ${err.message}`);
  }

  const dbFiles = entries.filter((name) => name.endsWith(".log") || name.endsWith(".ldb"));
  if (dbFiles.length === 0) {
    throw new Error(`no .log or .ldb files found in ${LEVELDB_DIR}`);
  }

  const workDir = join(tmpdir(), `stremio-rpc-leveldb-${process.pid}-${Date.now()}`);
  const copies = [];
  try {
    await mkdir(workDir, { recursive: true });

    for (const name of dbFiles) {
      const dest = join(workDir, name);
      try {
        await copyFile(join(LEVELDB_DIR, name), dest);
        copies.push(dest);
      } catch (err) {
        log.debug(`skipping locked/unreadable LevelDB file ${name}: ${err.message}`);
      }
    }

    if (copies.length === 0) {
      throw new Error(
        `could not copy any LevelDB files out of ${LEVELDB_DIR}; all were locked or unreadable`,
      );
    }

    for (const copyPath of copies) {
      let buf;
      try {
        buf = await readFile(copyPath);
      } catch (err) {
        log.debug(`failed to read copied LevelDB file ${copyPath}: ${err.message}`);
        continue;
      }
      const text = `${extractPrintableRuns(buf, "latin1")}\n${extractPrintableRuns(buf, "utf16le")}`;
      const key = findAuthKeyInText(text);
      if (key) return key;
    }

    throw new Error(
      `auth.key not found in Stremio LevelDB; sign in to Stremio at https://web.stremio.com in the desktop app first`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch((err) =>
      log.debug(`failed to clean up temp LevelDB copies at ${workDir}: ${err.message}`),
    );
  }
}

async function loginWithCredentials() {
  const email = process.env.STREMIO_EMAIL;
  const password = process.env.STREMIO_PASSWORD;
  if (!email || !password) return null;

  let res;
  try {
    res = await fetch(LOGIN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new Error(`Stremio login request failed: ${err.message}`);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`Stremio login returned a non-JSON response (HTTP ${res.status}): ${err.message}`);
  }

  if (!res.ok || body?.error) {
    const detail = body?.error?.message || body?.error || `HTTP ${res.status}`;
    throw new Error(`Stremio login failed: ${detail}`);
  }

  const key = body?.result?.authKey;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Stremio login succeeded but no authKey was present in the response");
  }
  return key;
}

export async function getAuthKey({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await readCachedKey();
    if (cached) {
      log.debug("using cached Stremio authKey");
      return cached;
    }
  }

  try {
    const key = await extractFromLevelDb();
    await cacheKey(key);
    log.success("extracted Stremio authKey from local app data");
    return key;
  } catch (extractErr) {
    log.debug(`LevelDB auth extraction failed: ${extractErr.message}`);

    const loginKey = await loginWithCredentials();
    if (loginKey) {
      await cacheKey(loginKey);
      log.success("obtained Stremio authKey via email/password login");
      return loginKey;
    }

    throw new Error(
      `could not obtain a Stremio authKey: ${extractErr.message}. ` +
        `Set STREMIO_EMAIL and STREMIO_PASSWORD env vars to log in, or sign in to the Stremio desktop app.`,
    );
  }
}
