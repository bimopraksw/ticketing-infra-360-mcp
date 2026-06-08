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
 * - explicit `executablePath`: pin Playwright's own Chromium so nothing else
 *   can be resolved by accident.
 * - cleaned `env`: drop `ELECTRON_RUN_AS_NODE` (set by Electron hosts) so it
 *   never leaks into the browser process.
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
    /* ensureChromium() runs first; if path can't resolve, let launch use default */
  }
  return launch;
}

let ensured: Promise<void> | null = null;

/**
 * Make sure Playwright's Chromium binary is present before we try to launch it.
 *
 * When the server is installed as a Claude Desktop extension (.mcpb), there is
 * no `npm install` / `postinstall` step to download the browser — so on a fresh
 * machine the binary is missing. This detects that and runs
 * `playwright install chromium` once, into Playwright's default cache. It's a
 * no-op (fast) when the browser is already installed.
 *
 * The result is memoized so concurrent/repeated launches install at most once.
 */
export function ensureChromium(): Promise<void> {
  if (!ensured) ensured = run();
  return ensured;
}

async function run(): Promise<void> {
  // executablePath() returns the expected location even when not yet installed;
  // existsSync tells us whether it's actually there.
  let alreadyInstalled = false;
  try {
    alreadyInstalled = existsSync(chromium.executablePath());
  } catch {
    alreadyInstalled = false;
  }
  if (alreadyInstalled) return;

  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  if (!existsSync(cli)) {
    logger.warn("Playwright CLI not found; cannot auto-install Chromium", { cli });
    return; // let the launch fail with Playwright's own (clear) error
  }

  logger.info("Chromium not found — installing it once (first run, ~150MB)…");
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, "install", "chromium"],
      { env: process.env, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()),
    );
    child.stdout?.on("data", (d) => logger.debug(String(d).trim()));
    child.stderr?.on("data", (d) => logger.debug(String(d).trim()));
  });
  logger.info("Chromium installed.");
}
