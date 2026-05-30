const ANSI = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
};

function timestamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function emit(stream, color, label, msg) {
  stream(`${ANSI.gray}${timestamp()}${ANSI.reset} ${color}${label}${ANSI.reset} ${msg}`);
}

export const log = {
  info(msg) {
    emit(console.log, ANSI.cyan, "INFO ", msg);
  },
  warn(msg) {
    emit(console.warn, ANSI.yellow, "WARN ", msg);
  },
  error(msg) {
    emit(console.error, ANSI.red, "ERROR", msg);
  },
  success(msg) {
    emit(console.log, ANSI.green, "OK   ", msg);
  },
  debug(msg) {
    if (!process.env.DEBUG) return;
    emit(console.log, ANSI.magenta, "DEBUG", msg);
  },
};
