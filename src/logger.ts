/**
 * Minimal leveled logger.
 *
 * CRITICAL: a stdio MCP server uses stdout for the JSON-RPC protocol.
 * All human/debug logging MUST go to stderr, otherwise it corrupts the
 * protocol stream and the client disconnects. Everything here writes to
 * process.stderr only.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: Level = "info";

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

function write(level: Level, msg: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const ts = new Date().toISOString();
  let line = `[${ts}] ${level.toUpperCase()} ${msg}`;
  if (meta !== undefined) {
    try {
      line += ` ${typeof meta === "string" ? meta : JSON.stringify(meta)}`;
    } catch {
      line += ` ${String(meta)}`;
    }
  }
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (msg: string, meta?: unknown) => write("debug", msg, meta),
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
};
