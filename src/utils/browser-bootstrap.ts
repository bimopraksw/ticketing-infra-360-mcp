import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium, type LaunchOptions } from "playwright";
import { logger } from "../logger.js";

const require = createRequire(import.meta.url);

/**
 * Build hardened Chromium launch options that work even when the server is
 * spawned from inside an Electron host (e.g. Claude Desktop).
 *
 * - `--disable-gpu` / `--disable-software-rasterizer`: avoid the GPU/helper
 *   subprocess crash seen when Chromium launches inside a sandboxed/Electron-
 *   spawned process.
 * - `--no-sandbox` / `--disable-dev-shm-usage`: standard flags for constrained
 *   environments.
 * - explicit `executablePath`: pin Playwright's own Chromium.
 * - cleaned `env`: drop `ELECTRON_RUN_AS_NODE` so it never leaks into the
 *   browser process.
 */
export function chromiumLaunchOptions(opts: { headless: boolean }): LaunchOptions {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
  }
  const launch: LaunchOptions = {
    headless: opts.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
    env,
  };
  try {
    const exe = chromium.executablePath();
    if (existsSync(exe)) launch.executablePath = exe;
  } catch {
    /* requireChromium() guards the missing case before we get here */
  }
  return launch;
}

/** True when Playwright's Chromium binary is actually present on disk. */
export function chromiumPresent(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** Marker file written while a background Chromium install is running. */
function installLockPath(): string {
  return join(tmpdir(), "ticketing-infra-360", "chromium-install.lock");
}

/** True when a background install kicked off recently and may still be running. */
export function chromiumInstallInProgress(): boolean {
  try {
    const p = installLockPath();
    if (!existsSync(p)) return false;
    // A lock older than 20 min is stale (install died/finished) — ignore it so
    // we can retry rather than wait forever.
    return Date.now() - statSync(p).mtimeMs < 20 * 60_000;
  } catch {
    return false;
  }
}

/**
 * Kicks off a Chromium install in a FULLY DETACHED background process and
 * returns immediately. Detaching (own process group, stdio ignored, unref'd)
 * is what makes this safe to call from inside an Electron host such as Claude
 * Desktop: the installer is decoupled from the host's lifecycle, so it can't
 * take the app down — unlike a blocking in-process install. Best-effort: any
 * failure is swallowed (the next retry surfaces it via requireChromium()).
 */
/** True when the user opted out of automatic Chromium install. Trims to match config.ts. */
export function autoInstallDisabled(): boolean {
  const v = process.env.LINKIT_AUTO_INSTALL_BROWSER;
  return !!v && ["false", "0", "no", "off"].includes(v.trim().toLowerCase());
}

export function startBackgroundChromiumInstall(): void {
  // Respect the opt-out switch and don't stack up duplicate installers.
  if (autoInstallDisabled()) return;
  if (chromiumPresent() || chromiumInstallInProgress()) return;
  try {
    const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
    if (!existsSync(cli)) return;
    const lock = installLockPath();
    mkdirSync(dirname(lock), { recursive: true });
    // Touch the lock so concurrent servers don't each start an installer.
    writeFileSync(lock, String(Date.now()));
    const logPath = join(homedir(), ".linkit360", "chromium-install.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const out = openSync(logPath, "a");
    logger.info("Installing Chromium in the background (~150MB); no restart needed", { logPath });
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      // ELECTRON_RUN_AS_NODE=1 makes the host's Electron binary behave as plain
      // node for the child; detached + ignored stdio severs the host link.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      stdio: ["ignore", out, out],
    });
    // An async spawn failure must not become an uncaughtException (could crash
    // the host). Clear the lock on both failure and exit so we don't get stuck.
    child.on("error", (err) => {
      logger.warn("Chromium install failed to start", err instanceof Error ? err.message : err);
      try { rmSync(lock, { force: true }); } catch { /* ignore */ }
    });
    child.on("exit", () => {
      try { rmSync(lock, { force: true }); } catch { /* ignore */ }
    });
    child.unref();
    // Close the parent's copy of the log fd; the child kept its own.
    try { closeSync(out); } catch { /* ignore */ }
  } catch (e) {
    logger.warn("Could not start background Chromium install", e instanceof Error ? e.message : e);
  }
}

/**
 * Guard used by the MCP server before launching a browser. If Chromium is
 * missing it (a) kicks off a detached background install and (b) throws a
 * SOFT, retryable message. It never tells the user to open a terminal or quit
 * and reopen the app — the install happens on its own and the next attempt
 * just works.
 */
export function requireChromium(): void {
  if (chromiumPresent()) return;
  // Opted out of auto-install: give an actual recovery path (this is the one
  // case where pointing at a terminal command is correct).
  if (autoInstallDisabled()) {
    throw new Error(
      "Chromium isn't installed and automatic install is disabled " +
        "(LINKIT_AUTO_INSTALL_BROWSER=false). Install it once with " +
        "`npx playwright install chromium`, or remove that setting to let it " +
        "install automatically.",
    );
  }
  startBackgroundChromiumInstall();
  const inProgress = chromiumInstallInProgress();
  throw new Error(
    inProgress
      ? "Chromium is still installing in the background (~150MB, one-time). " +
          "No action needed — just try the same request again in a minute. " +
          "You do NOT need to restart anything."
      : "Chromium isn't available yet and the automatic install couldn't start. " +
          "It will retry automatically; try again shortly. No restart needed.",
  );
}

/**
 * Install Chromium if missing — ONLY safe to call from the standalone terminal
 * CLI (`ticketing-infra-360-login`), never from the MCP server running under a
 * host app. Blocks until the download finishes.
 */
export async function ensureChromium(): Promise<void> {
  if (chromiumPresent()) return;
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  if (!existsSync(cli)) {
    throw new Error(`Playwright CLI not found at ${cli}; run: npx playwright install chromium`);
  }
  logger.info("Chromium not found — installing once (~150MB)…");
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const child = execFile(
      process.execPath,
      [cli, "install", "chromium"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err) =>
        err
          ? reject(new Error(`${err.message}${stderr ? ` | ${stderr.slice(-500)}` : ""}`))
          : resolve(),
    );
    child.stdout?.on("data", (d) => logger.debug(String(d).trim()));
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      logger.debug(String(d).trim());
    });
  });
  logger.info("Chromium installed.");
}
