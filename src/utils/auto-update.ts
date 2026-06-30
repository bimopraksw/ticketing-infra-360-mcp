import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";

/**
 * Fires off the self-updater in a fully detached background process and returns
 * immediately. Called once on server startup. It never blocks the MCP stdio
 * handshake and never writes to stdout — the child logs to
 * ~/.linkit360/auto-update.log and stages any update for the next launch.
 *
 * Detaching is what makes this safe under an Electron host (Claude Desktop):
 * the updater outlives a quick request and can't take the host down.
 */
export function startBackgroundAutoUpdate(cfg: AppConfig): void {
  if (!cfg.autoUpdate) return;
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // dist/utils
    const script = join(here, "..", "cli", "self-update.js");
    if (!existsSync(script)) {
      logger.debug("Self-update script not found; skipping auto-update", { script });
      return;
    }
    const logPath = join(homedir(), ".linkit360", "auto-update.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const out = openSync(logPath, "a");
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      stdio: ["ignore", out, out],
    });
    // A spawn that fails ASYNCHRONOUSLY emits 'error'; without a listener Node
    // turns it into an uncaughtException that could crash the host. Swallow it.
    child.on("error", (err) =>
      logger.warn("Auto-update child failed to start", err instanceof Error ? err.message : err),
    );
    child.unref();
    // The child holds its own dup'd handle to the log now; close the parent's
    // copy so we don't leak a file descriptor.
    try {
      closeSync(out);
    } catch {
      /* ignore */
    }
    logger.info("Checking for updates in the background (applies on next launch)");
  } catch (e) {
    logger.warn("Could not start background auto-update", e instanceof Error ? e.message : e);
  }
}
