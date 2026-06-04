#!/usr/bin/env node
/**
 * Interactive login CLI.
 *
 * LinkIT360's login page is protected by reCAPTCHA v2, which cannot (and must
 * not) be solved by automation. This command opens a REAL visible browser so
 * you can log in manually — including solving the reCAPTCHA — then persists the
 * resulting session (cookies) to disk. The headless MCP server reuses that
 * session for all subsequent operations until it expires.
 *
 * Usage:  npm run login
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, resolveUrl } from "../config.js";

const cfg = loadConfig();
const loginUrl = resolveUrl(cfg.baseUrl, cfg.login.path);

const isLoginUrl = (u: string): boolean => {
  try {
    return new URL(u).pathname.toLowerCase().includes("login");
  } catch {
    return false;
  }
};

async function hasValidSessionFile(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed?.cookies) && parsed.cookies.length > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.error("Opening a visible browser for manual login…");
  const browser = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    locale: cfg.locale,
    storageState: (await hasValidSessionFile(cfg.sessionPath)) ? cfg.sessionPath : undefined,
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  await page.goto(cfg.baseUrl, { waitUntil: "domcontentloaded" });
  if (!isLoginUrl(page.url())) {
    console.error("✓ Existing session is still valid — no login needed.");
    await saveAndClose(context, browser);
    return;
  }

  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  // Pre-fill credentials to save the user typing; they still solve the captcha.
  try {
    await page.fill('input[name="email"], input[type="email"], #email', cfg.email, { timeout: 5000 });
    await page.fill('input[name="password"], input[type="password"], #password', cfg.password, { timeout: 5000 });
    console.error("✓ Email & password pre-filled from .env.");
  } catch {
    console.error("(Could not pre-fill fields — please type credentials manually.)");
  }

  console.error("\n──────────────────────────────────────────────────────────");
  console.error(" Please, in the browser window:");
  console.error("   1. Solve the reCAPTCHA (\"I'm not a robot\").");
  console.error("   2. Click the Login button.");
  console.error(" Waiting up to 5 minutes for you to reach a logged-in page…");
  console.error("──────────────────────────────────────────────────────────\n");

  // Poll until we leave the login page (i.e. login succeeded).
  const deadline = Date.now() + 5 * 60_000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    if (!isLoginUrl(page.url())) {
      loggedIn = true;
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (!loggedIn) {
    console.error("✗ Timed out waiting for login. Nothing saved.");
    await browser.close();
    process.exit(1);
  }

  await page.waitForLoadState("networkidle").catch(() => undefined);
  console.error(`✓ Logged in — landed on ${page.url()}`);
  await saveAndClose(context, browser);
}

async function saveAndClose(
  context: import("playwright").BrowserContext,
  browser: import("playwright").Browser,
): Promise<void> {
  await mkdir(dirname(cfg.sessionPath), { recursive: true });
  const state = await context.storageState();
  await writeFile(cfg.sessionPath, JSON.stringify(state, null, 2), "utf8");
  console.error(`✓ Session saved to ${cfg.sessionPath} (${state.cookies.length} cookies).`);
  console.error("  The MCP server and crawler will now reuse this session.");
  await browser.close();
}

main().catch((err) => {
  console.error("Login CLI failed:", err?.stack || err);
  process.exit(1);
});
