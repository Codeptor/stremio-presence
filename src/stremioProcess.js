import { execFile } from "node:child_process";
import { config } from "./config.js";
import { log } from "./log.js";

export async function isStremioRunning() {
  const name = config.stremioProcessName;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        "tasklist",
        ["/FI", `IMAGENAME eq ${name}`, "/NH"],
        { windowsHide: true },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    return stdout.toLowerCase().includes(name.toLowerCase());
  } catch (err) {
    log.debug(`tasklist failed while checking for ${name}: ${err.message}`);
    return false;
  }
}
