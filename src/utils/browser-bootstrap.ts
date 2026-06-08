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
    /* startChromiumInstall() handles the missing case; let launch use default */
  }
  return launch;
}

// ---------------------------------------------------------------------------
// Chromium bootstrap (download-on-first-use)
//
// When installed as a Claude Desktop extension (.mcpb) there is no npm
// `postinstall`, so on a fresh machine the browser binary is missing. We can't
// block a tool call to download ~150MB — that overruns the MCP timeout and the
// host kills the call. Instead we kick the download off in the BACKGROUND at
// server startup, isolated in a child process so a failure can't crash us, and
// have tool calls return fast: "ready" → proceed, "installing" → a friendly
// retry message, "failed" → the real error + a one-line terminal fallback.
// ---------------------------------------------------------------------------

type InstallState = "unknown" | "installing" | "ready" | "failed";
let state: InstallState = "unknown";
let installPromise: Promise<void> | null = null;
let installError = "";

function chromiumPresent(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

function downloadChromium(): Promise<void> {
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  if (!existsSync(cli)) {
    return Promise.reject(new Error(`Playwright CLI not found at ${cli}`));
  }
  logger.info("Chromium not found — downloading once in the background (~150MB)…");
  return new Promise<void>((resolve, reject) => {
    let stderr = "";
    const child = execFile(
      process.execPath,
      [cli, "install", "chromium"],
      {
        // Force pure-Node mode in case the host runtime is Electron — otherwise
        // spawning `process.execPath` launches the GUI app and crashes.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 15 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err) =>
        err
          ? reject(new Error(`${err.message}${stderr ? ` | ${stderr.slice(-500)}` : ""}`))
          : resolve(),
    );
    child.stdout?.on("data", (d) => logger.debug(String(d).trim()));
    child.stderr?.on("data", (d) => {
      const s = String(d);
      stderr += s;
      logger.debug(s.trim());
    });
  });
}

/**
 * Begin the Chromium download in the background if it's missing. Safe to call
 * at startup and repeatedly: it's a no-op when already installed or in flight,
 * and a child-process failure is captured (never throws / never crashes us).
 */
export function startChromiumInstall(): void {
  if (chromiumPresent()) {
    state = "ready";
    return;
  }
  if (installPromise) return;
  state = "installing";
  installPromise = downloadChromium().then(
    () => {
      state = "ready";
      logger.info("Chromium installed.");
    },
    (e: unknown) => {
      state = "failed";
      installError = e instanceof Error ? e.message : String(e);
      logger.warn("Chromium auto-install failed", { error: installError });
    },
  );
}

const TERMINAL_HINT =
  "Run this ONCE in a terminal, then retry: npx playwright install chromium";

/**
 * For MCP tool launch paths. Never blocks long enough to hit the MCP timeout:
 * returns immediately when Chromium is ready, otherwise starts the background
 * download and throws a short, actionable message for the agent to relay.
 */
export async function ensureChromiumReady(): Promise<void> {
  if (chromiumPresent()) {
    state = "ready";
    return;
  }
  if (state === "ready") return;
  if (!installPromise) startChromiumInstall();

  if (state === "failed") {
    throw new Error(
      `Chromium could not be installed automatically inside the app:\n${installError}\n${TERMINAL_HINT}`,
    );
  }
  throw new Error(
    "Chromium is downloading for first-time use (~150MB, one-time only). " +
      "It runs in the background — please send the same request again in about a minute. " +
      `If it still fails after a few tries: ${TERMINAL_HINT}`,
  );
}

/**
 * For the standalone terminal login CLI, where blocking is fine (no MCP
 * timeout). Awaits the full download and throws the real error if it fails.
 */
export async function ensureChromium(): Promise<void> {
  if (chromiumPresent()) return;
  startChromiumInstall();
  await installPromise;
  if (!chromiumPresent()) {
    throw new Error(installError || "Chromium installation failed.");
  }
}
