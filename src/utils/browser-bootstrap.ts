import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

const INSTALL_INSTRUCTIONS =
  "Chromium is not installed on this machine yet.\n\n" +
  "This MCP server does NOT install it automatically — installing Chromium must " +
  "be done from a TERMINAL, not from inside the app (doing it inside the app " +
  "crashes the host). Run this ONCE in a terminal, then fully quit & reopen the app:\n\n" +
  "  npx -p ticketing-infra-360-mcp ticketing-infra-360-login\n\n" +
  "(That command installs Chromium AND logs you in. Alternatively, just install " +
  "the browser with:  npx playwright install chromium )";

/**
 * Guard used by the MCP server before launching a browser. It NEVER installs
 * anything — it only checks whether Chromium is present and, if not, throws a
 * clear message telling the user to install it from a terminal. This is
 * deliberate: spawning the Playwright installer from inside an Electron host
 * (Claude Desktop) crashes it.
 */
export function requireChromium(): void {
  if (chromiumPresent()) return;
  throw new Error(INSTALL_INSTRUCTIONS);
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
