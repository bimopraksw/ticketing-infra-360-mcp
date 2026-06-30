import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { requireChromium, chromiumLaunchOptions } from "./utils/browser-bootstrap.js";

/**
 * Owns the single shared Chromium instance and browser context.
 *
 * The context is created from a persisted `storageState` file when present,
 * so a previously established login session is restored automatically.
 * Tools acquire short-lived pages via `withPage`.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<void> | null = null;

  constructor(private readonly cfg: AppConfig) {}

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    // Guard against concurrent launches racing each other.
    if (!this.launching) {
      this.launching = this.launch();
    }
    await this.launching;
    if (!this.context) throw new Error("Browser context failed to initialize");
    return this.context;
  }

  private async launch(): Promise<void> {
    requireChromium();
    logger.info("Launching Chromium", { headless: this.cfg.headless });
    this.browser = await chromium.launch(
      chromiumLaunchOptions({ headless: this.cfg.headless }),
    );
    this.context = await this.newContextFromSession();
    logger.info("Browser context ready");
  }

  /** Creates a context, restoring the saved session if one exists. */
  private async newContextFromSession(): Promise<BrowserContext> {
    if (!this.browser) throw new Error("browser not launched");
    const hasSession =
      existsSync(this.cfg.sessionPath) &&
      (await this.isValidStorageState(this.cfg.sessionPath));
    const ctx = await this.browser.newContext({
      locale: this.cfg.locale,
      storageState: hasSession ? this.cfg.sessionPath : undefined,
      viewport: { width: 1366, height: 900 },
    });
    ctx.setDefaultTimeout(this.cfg.timeoutMs);
    ctx.setDefaultNavigationTimeout(this.cfg.timeoutMs);
    logger.debug("Context created", { restoredSession: hasSession });
    return ctx;
  }

  /**
   * Re-reads the persisted session file into a fresh context. Call this after
   * an out-of-band login (e.g. the interactive headed login) so the running
   * headless browser immediately picks up the new cookies.
   */
  async reloadSession(): Promise<void> {
    if (!this.browser) {
      // Not launched yet — the next ensureContext() will load the new session.
      this.context = null;
      this.launching = null;
      return;
    }
    if (this.context) {
      // Refresh cookies IN PLACE rather than closing+recreating the context.
      // Closing the shared context would yank it out from under any page a
      // concurrent tool call is mid-operation on ("Target closed"). Re-applying
      // the freshly saved cookies is enough for the Laravel session auth.
      try {
        const raw = await readFile(this.cfg.sessionPath, "utf8");
        const state = JSON.parse(raw) as Awaited<ReturnType<BrowserContext["storageState"]>>;
        if (Array.isArray(state.cookies) && state.cookies.length > 0) {
          await this.context.clearCookies().catch(() => undefined);
          await this.context.addCookies(state.cookies);
          logger.info("Session cookies refreshed into the running context");
          return;
        }
      } catch (e) {
        logger.warn(
          "In-place session refresh failed; recreating context",
          e instanceof Error ? e.message : e,
        );
      }
      // Fallback only if the in-place refresh wasn't possible.
      await this.context.close().catch(() => undefined);
    }
    this.context = await this.newContextFromSession();
    logger.info("Session reloaded into running browser");
  }

  private async isValidStorageState(path: string): Promise<boolean> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.cookies);
    } catch {
      logger.warn("Existing session file is invalid; ignoring it", { path });
      return false;
    }
  }

  /** Persists current cookies/localStorage so the session survives restarts. */
  async saveSession(): Promise<void> {
    if (!this.context) return;
    await mkdir(dirname(this.cfg.sessionPath), { recursive: true });
    const state = await this.context.storageState();
    await writeFile(this.cfg.sessionPath, JSON.stringify(state, null, 2), "utf8");
    logger.debug("Session persisted", { path: this.cfg.sessionPath });
  }

  /** Discards the current session both in memory and on disk. */
  async clearSession(): Promise<void> {
    if (this.context) {
      await this.context.clearCookies();
    }
    try {
      await writeFile(
        this.cfg.sessionPath,
        JSON.stringify({ cookies: [], origins: [] }, null, 2),
        "utf8",
      );
    } catch {
      /* ignore */
    }
    logger.info("Session cleared");
  }

  /** Runs `fn` with a fresh page, always closing the page afterwards. */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.context = null;
    this.browser = null;
    this.launching = null;
    logger.info("Browser closed");
  }
}
