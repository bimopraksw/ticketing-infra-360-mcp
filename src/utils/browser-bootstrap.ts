import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { logger } from "../logger.js";

const require = createRequire(import.meta.url);

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
