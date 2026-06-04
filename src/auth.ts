import { chromium, type Page } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import { resolveUrl } from "./config.js";
import { logger } from "./logger.js";
import { BrowserManager } from "./browser.js";
import { withRetry } from "./utils/retry.js";

/**
 * Candidate selectors tried (in order) when the login form fields are not
 * explicitly configured. Covers the common Laravel/Blade conventions.
 */
const EMAIL_CANDIDATES = [
  'input[name="email"]',
  'input[type="email"]',
  'input[name="username"]',
  'input[name="login"]',
  "#email",
  "#username",
];
const PASSWORD_CANDIDATES = [
  'input[name="password"]',
  'input[type="password"]',
  "#password",
];
const SUBMIT_CANDIDATES = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Login")',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
  'button:has-text("Masuk")',
];

export class AuthManager {
  constructor(
    private readonly cfg: AppConfig,
    private readonly browser: BrowserManager,
  ) {}

  private loginUrl(): string {
    return resolveUrl(this.cfg.baseUrl, this.cfg.login.path);
  }

  /** True if the given URL looks like the login page. */
  private isOnLoginPage(url: string): boolean {
    try {
      const path = new URL(url).pathname.toLowerCase();
      return (
        path.includes("login") ||
        path === this.cfg.login.path.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  /**
   * Checks whether the current persisted session is still authenticated.
   * Navigates to the base URL and observes whether we get bounced to login.
   */
  async isAuthenticated(): Promise<boolean> {
    return this.browser.withPage(async (page) => {
      try {
        await page.goto(this.cfg.baseUrl, { waitUntil: "domcontentloaded" });
        const finalUrl = page.url();
        const loggedIn = !this.isOnLoginPage(finalUrl);
        logger.debug("Auth check", { finalUrl, loggedIn });
        return loggedIn;
      } catch (error) {
        logger.warn("Auth check failed", error instanceof Error ? error.message : error);
        return false;
      }
    });
  }

  private async findSelector(
    page: Page,
    configured: string | undefined,
    candidates: string[],
    kind: string,
  ): Promise<string> {
    if (configured) {
      const count = await page.locator(configured).count();
      if (count > 0) return configured;
      logger.warn(`Configured ${kind} selector matched nothing; falling back to auto-detect`, {
        configured,
      });
    }
    for (const sel of candidates) {
      const count = await page.locator(sel).count();
      if (count > 0) return sel;
    }
    throw new Error(
      `Could not locate the ${kind} field on the login page. ` +
        `Set the appropriate LINKIT_LOGIN_*_SELECTOR env var. Tried: ${candidates.join(", ")}`,
    );
  }

  /**
   * Performs an interactive login by driving the real form, then persists
   * the resulting session. Laravel CSRF tokens and session cookies are
   * handled automatically because we submit the actual rendered form.
   */
  async login(force = false): Promise<{ success: boolean; finalUrl: string }> {
    if (!force) {
      const already = await this.isAuthenticated();
      if (already) {
        logger.info("Existing session is still valid; skipping login");
        return { success: true, finalUrl: this.cfg.baseUrl };
      }
    }

    const result = await withRetry(
      () => this.performLogin(),
      {
        retries: this.cfg.maxRetries,
        label: "login",
        baseDelayMs: 1000,
      },
    );

    await this.browser.saveSession();
    return result;
  }

  /** Detects whether the login page is protected by a CAPTCHA. */
  private async hasCaptcha(page: Page): Promise<boolean> {
    return page
      .evaluate(() => {
        return (
          !!document.querySelector(".g-recaptcha, [data-sitekey]") ||
          Array.from(document.querySelectorAll("iframe")).some((f) =>
            /recaptcha|hcaptcha|turnstile/i.test(f.src),
          )
        );
      })
      .catch(() => false);
  }

  private async performLogin(): Promise<{ success: boolean; finalUrl: string }> {
    return this.browser.withPage(async (page) => {
      logger.info("Navigating to login page", { url: this.loginUrl() });
      await page.goto(this.loginUrl(), { waitUntil: "domcontentloaded" });

      // If the login page redirected us away, we're already authenticated.
      if (!this.isOnLoginPage(page.url())) {
        logger.info("Redirected away from login — already authenticated");
        return { success: true, finalUrl: page.url() };
      }

      // reCAPTCHA cannot be solved by automation. Direct the user to the
      // interactive login CLI, which establishes a reusable session.
      if (await this.hasCaptcha(page)) {
        throw new Error(
          "Login page is protected by reCAPTCHA, which cannot be solved automatically. " +
            "Run `npm run login` once to log in manually in a visible browser; the " +
            "session is saved and reused automatically. Re-run it whenever the session expires.",
        );
      }

      const emailSel = await this.findSelector(
        page,
        this.cfg.login.emailSelector,
        EMAIL_CANDIDATES,
        "email/username",
      );
      const passSel = await this.findSelector(
        page,
        this.cfg.login.passwordSelector,
        PASSWORD_CANDIDATES,
        "password",
      );
      const submitSel = await this.findSelector(
        page,
        this.cfg.login.submitSelector,
        SUBMIT_CANDIDATES,
        "submit button",
      );

      await page.fill(emailSel, this.cfg.email);
      await page.fill(passSel, this.cfg.password);

      logger.info("Submitting login form");
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: "domcontentloaded" })
          .catch(() => undefined),
        page.click(submitSel),
      ]);
      // Allow SPA/redirect chains to settle.
      await page.waitForLoadState("networkidle").catch(() => undefined);

      const finalUrl = page.url();
      const success = this.cfg.login.successUrl
        ? finalUrl.includes(this.cfg.login.successUrl)
        : !this.isOnLoginPage(finalUrl);

      if (!success) {
        const errorText = await this.extractLoginError(page);
        throw new Error(
          `Login failed — still on login page (${finalUrl}).` +
            (errorText ? ` Server message: "${errorText}"` : "") +
            ` Check LINKIT_EMAIL / LINKIT_PASSWORD.`,
        );
      }

      logger.info("Login successful", { finalUrl });
      return { success, finalUrl };
    });
  }

  /** Best-effort extraction of a validation/error message from the login page. */
  private async extractLoginError(page: Page): Promise<string | null> {
    const candidates = [
      ".alert-danger",
      ".invalid-feedback",
      ".text-danger",
      '[role="alert"]',
      ".error",
    ];
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        const text = (await loc.textContent())?.trim();
        if (text) return text.replace(/\s+/g, " ").slice(0, 300);
      }
    }
    return null;
  }

  /**
   * Ensures we are authenticated before an operation. If a stored session is
   * stale it transparently re-logs in.
   */
  async ensureAuthenticated(): Promise<void> {
    const ok = await this.isAuthenticated();
    if (!ok) {
      logger.info("Session expired or absent; re-authenticating");
      await this.login(true);
    }
  }

  /**
   * Opens a REAL (headed) browser so the user can log in manually — including
   * solving the reCAPTCHA — then persists the session and hot-reloads it into
   * the running headless browser. This is what the `login` tool calls so the
   * whole flow happens from inside the MCP client (no separate terminal step).
   *
   * Requires a graphical display on the machine running the server.
   */
  async interactiveLogin(
    timeoutMs = 180000,
  ): Promise<{ success: boolean; finalUrl: string; alreadyValid?: boolean }> {
    logger.info("Starting interactive login (headed browser)");
    let headed;
    try {
      headed = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
    } catch (e) {
      throw new Error(
        "Could not open a visible browser for interactive login. This requires a " +
          "machine with a graphical display. Error: " +
          (e instanceof Error ? e.message : String(e)),
      );
    }

    try {
      const hasSession =
        existsSync(this.cfg.sessionPath) && (await this.sessionFileValid());
      const context = await headed.newContext({
        locale: this.cfg.locale,
        storageState: hasSession ? this.cfg.sessionPath : undefined,
        viewport: { width: 1366, height: 900 },
      });
      const page = await context.newPage();

      await page.goto(this.cfg.baseUrl, { waitUntil: "domcontentloaded" });
      if (!this.isOnLoginPage(page.url())) {
        logger.info("Session already valid — no manual login needed");
        await this.persistFromContext(context);
        await headed.close();
        await this.browser.reloadSession();
        return { success: true, finalUrl: page.url(), alreadyValid: true };
      }

      await page.goto(this.loginUrl(), { waitUntil: "domcontentloaded" });
      // Pre-fill credentials to save typing; user still solves the captcha.
      await page
        .fill('input[name="email"], input[type="email"], #email', this.cfg.email, { timeout: 5000 })
        .catch(() => undefined);
      await page
        .fill('input[name="password"], input[type="password"], #password', this.cfg.password, { timeout: 5000 })
        .catch(() => undefined);

      logger.info(`Waiting up to ${Math.round(timeoutMs / 1000)}s for manual login…`);
      const deadline = Date.now() + timeoutMs;
      let loggedIn = false;
      while (Date.now() < deadline) {
        if (!this.isOnLoginPage(page.url())) {
          loggedIn = true;
          break;
        }
        await page.waitForTimeout(1000);
      }

      if (!loggedIn) {
        await headed.close();
        throw new Error(
          `Interactive login timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            "Solve the reCAPTCHA and click Login within the time window, then retry.",
        );
      }

      await page.waitForLoadState("networkidle").catch(() => undefined);
      const finalUrl = page.url();
      await this.persistFromContext(context);
      await headed.close();
      await this.browser.reloadSession();
      logger.info("Interactive login complete; session saved & reloaded", { finalUrl });
      return { success: true, finalUrl };
    } catch (e) {
      await headed.close().catch(() => undefined);
      throw e;
    }
  }

  private async sessionFileValid(): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(this.cfg.sessionPath, "utf8"));
      return Array.isArray(parsed?.cookies) && parsed.cookies.length > 0;
    } catch {
      return false;
    }
  }

  private async persistFromContext(
    context: import("playwright").BrowserContext,
  ): Promise<void> {
    await mkdir(dirname(this.cfg.sessionPath), { recursive: true });
    const state = await context.storageState();
    await writeFile(this.cfg.sessionPath, JSON.stringify(state, null, 2), "utf8");
  }
}
