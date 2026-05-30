import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { log } from "./log.js";

const PLACEHOLDER_CLIENT_ID = "YOUR_DISCORD_APP_ID";

export const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");

const defaults = {
  discordClientId: "",
  pollIntervalMs: 15000,
  staleSeconds: 150,
  pausedMaxSeconds: 180,
  posterSize: "medium",
  smallImageUrl: "",
  showImdbButton: true,
  showStremioButton: true,
  showQuality: true,
  showBrowsing: true,
  showTray: true,
  stremioProcessName: "stremio-shell-ng.exe",
};

function loadConfigFile() {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read config.json at ${configPath}: ${err.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config.json must contain a JSON object");
    }
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse config.json at ${configPath}: ${err.message}`);
  }
}

function parseIntEnv(name, raw) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function build() {
  const file = loadConfigFile();
  const merged = { ...defaults, ...file };

  if (process.env.DISCORD_CLIENT_ID !== undefined && process.env.DISCORD_CLIENT_ID !== "") {
    merged.discordClientId = process.env.DISCORD_CLIENT_ID;
  }
  if (process.env.POLL_INTERVAL_MS !== undefined && process.env.POLL_INTERVAL_MS !== "") {
    merged.pollIntervalMs = parseIntEnv("POLL_INTERVAL_MS", process.env.POLL_INTERVAL_MS);
  }
  if (process.env.STALE_SECONDS !== undefined && process.env.STALE_SECONDS !== "") {
    merged.staleSeconds = parseIntEnv("STALE_SECONDS", process.env.STALE_SECONDS);
  }

  for (const key of ["pollIntervalMs", "staleSeconds", "pausedMaxSeconds"]) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) {
      throw new Error(`config.json ${key} must be a positive number, got ${JSON.stringify(merged[key])}`);
    }
  }

  const id = merged.discordClientId;
  if (!id || id.trim() === "" || id === PLACEHOLDER_CLIENT_ID) {
    log.warn(
      "discordClientId is not set — Discord presence is disabled until you set it in config.json or DISCORD_CLIENT_ID.",
    );
  }

  return merged;
}

export const config = build();

// Hot-reload: re-read config.json and mutate the exported object in place so live readers pick up the
// change. Numeric/JSON errors keep the current values. Most options apply on the next tick; only
// discordClientId needs the presence client recreated (the caller handles that).
export function reloadConfig() {
  try {
    const fresh = build();
    const clientIdChanged = fresh.discordClientId !== config.discordClientId;
    Object.assign(config, fresh);
    return { ok: true, clientIdChanged };
  } catch (err) {
    log.warn(`config.json reload failed, keeping current values: ${err.message}`);
    return { ok: false, clientIdChanged: false };
  }
}
