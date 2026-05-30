import mod from "systray2";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { log } from "./log.js";

// systray2 is CJS; the class lands at a different depth depending on interop.
const SysTray =
  typeof mod === "function" ? mod : typeof mod.default === "function" ? mod.default : mod.default?.default;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEPARATOR = SysTray?.separator ?? { title: "<SEPARATOR>", enabled: false };

// Creates a system-tray icon with a live status line and a small menu. If the tray helper can't start
// (binary missing, no session, etc.) it degrades to a no-op so the helper keeps running headless.
export async function createTray({ onQuit, onOpenConfig, onOpenFolder } = {}) {
  let systray = null;
  let lastStatus = null;
  const statusItem = { title: "Starting…", tooltip: "Current status", enabled: false };
  const items = [
    statusItem,
    SEPARATOR,
    { title: "Open config.json", tooltip: "Edit settings", enabled: true },
    { title: "Open folder", tooltip: "Open the install folder", enabled: true },
    SEPARATOR,
    { title: "Quit", tooltip: "Quit stremio-rpc", enabled: true },
  ];

  try {
    const icon = readFileSync(join(ROOT, "assets", "stremio.ico")).toString("base64");
    systray = new SysTray({
      menu: { icon, title: "", tooltip: "stremio-rpc", items },
      debug: false,
      copyDir: true,
    });
    await systray.ready();
    systray.onClick((action) => {
      const title = action?.item?.title;
      if (title === "Quit") onQuit?.();
      else if (title === "Open config.json") onOpenConfig?.();
      else if (title === "Open folder") onOpenFolder?.();
    });
    log.debug("Tray icon ready");
  } catch (err) {
    log.warn(`Tray icon unavailable (running headless): ${err.message}`);
    systray = null;
  }

  return {
    setStatus(text) {
      if (!systray || !text || text === lastStatus) return;
      lastStatus = text;
      statusItem.title = text.length > 90 ? `${text.slice(0, 89)}…` : text;
      systray.sendAction({ type: "update-item", item: statusItem, seq_id: 0 }).catch(() => {});
    },
    destroy() {
      if (!systray) return;
      try {
        systray.kill(false);
      } catch (_) {}
      systray = null;
    },
  };
}
