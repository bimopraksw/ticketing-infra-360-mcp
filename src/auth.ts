import { chromium, type APIRequestContext, type Page } from "playwright";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import { resolveUrl } from "./config.js";
import { logger } from "./logger.js";
import { BrowserManager } from "./browser.js";
import { withRetry } from "./utils/retry.js";
import { requireChromium, chromiumLaunchOptions } from "./utils/browser-bootstrap.js";

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
  /**
   * Single-flight guard for re-authentication. When several tool calls discover
   * an expired session at once, they must NOT each pop open their own browser
   * window — they all await this one shared login promise instead.
   */
  private reauthInFlight: Promise<void> | null = null;

  /** Set once the loaded session is confirmed to belong to LINKIT_EMAIL. */
  private verifiedAccount = false;

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

  /** Email of the account a session belongs to (read from /profile), or null if unreadable. */
  private async accountOf(api: APIRequestContext): Promise<string | null> {
    try {
      const resp = await api.get(resolveUrl(this.cfg.baseUrl, "/profile"));
      if (this.isOnLoginPage(resp.url())) return null;
      const tag = (await resp.text()).match(/<input[^>]*\bname=["']email["'][^>]*>/i)?.[0];
      return tag?.match(/\bvalue=["']([^"']*)["']/i)?.[1]?.trim() || null;
    } catch (e) {
      logger.warn("Could not read the logged-in account", e instanceof Error ? e.message : e);
      return null;
    }
  }

  private isConfiguredAccount(email: string): boolean {
    return email.trim().toLowerCase() === this.cfg.email.trim().toLowerCase();
  }

  /** Account the current session is logged in as, or null when logged out/unknown. */
  async sessionAccount(): Promise<string | null> {
    return this.accountOf(await this.browser.apiRequest());
  }

  /**
   * True only when the session is valid AND belongs to LINKIT_EMAIL. A session
   * for any other account is discarded, so tickets are never filed under
   * someone else's name.
   */
  async isAuthenticatedAsConfiguredAccount(): Promise<boolean> {
    if (!(await this.isAuthenticated())) return false;
    if (this.verifiedAccount) return true;
    const actual = await this.sessionAccount();
    if (actual === null) {
      // Profile page unreadable (layout change?): don't lock the user out over it.
      logger.warn("Could not verify which account the session belongs to; continuing");
      return true;
    }
    if (this.isConfiguredAccount(actual)) {
      this.verifiedAccount = true;
      return true;
    }
    logger.warn("Saved session belongs to a different account; discarding it", {
      sessionAccount: actual,
      configuredAccount: this.cfg.email,
    });
    await this.browser.clearSession();
    return false;
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
      const already = await this.isAuthenticatedAsConfiguredAccount();
      if (already) {
        logger.info("Existing session is still valid; skipping login");
        return { success: true, finalUrl: this.cfg.baseUrl };
      }
    }
    this.verifiedAccount = false;

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

      // reCAPTCHA cannot be solved by automation. Instead of failing, ask the
      // caller to use the interactive (headed) login — which the `login` tool
      // and seamless auto-login both do — so the user solves the captcha in a
      // real window. No terminal and no app restart needed.
      if (await this.hasCaptcha(page)) {
        throw new Error(
          "The login page uses reCAPTCHA, which can't be solved automatically. " +
            "Use the `login` tool (it opens a real browser window with your " +
            "credentials pre-filled — just solve the captcha and click Login). " +
            "This also happens automatically when a session expires.",
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
   *
   * Seamless mode (default): instead of failing with "run npm run login in a
   * terminal", we open a real browser window so the user can solve the captcha
   * right where they are, then continue the original operation automatically.
   * Concurrent callers share a single login (no duplicate windows).
   */
  async ensureAuthenticated(): Promise<void> {
    if (await this.isAuthenticatedAsConfiguredAccount()) {
      await this.persistRefreshedSession();
      return;
    }

    // Another MCP process (e.g. Claude Desktop next to Claude Code) may have
    // logged in since our context loaded the file. Reuse that before asking
    // the user to solve a captcha again.
    if (!this.reauthInFlight) {
      this.verifiedAccount = false;
      await this.browser.reloadSession();
      if (await this.isAuthenticatedAsConfiguredAccount()) {
        await this.persistRefreshedSession();
        return;
      }
    }

    // If a re-login is already running, JOIN it and trust its result — never
    // start our own (that would open a second browser window). This is the whole
    // point of the single-flight guard: contended callers must not each launch
    // interactiveLogin().
    if (this.reauthInFlight) {
      await this.reauthInFlight.catch(() => undefined);
      if (await this.isAuthenticatedAsConfiguredAccount()) return;
      throw new Error(
        "Login was required but did not complete. Use the `login` tool to finish " +
          "signing in (solve the captcha in the window that appears), then retry.",
      );
    }

    logger.info("Session expired or absent; re-authenticating", {
      autoLogin: this.cfg.autoLogin,
    });

    const p = (async () => {
      if (this.cfg.autoLogin) {
        // Open the visible browser automatically — the user just solves the
        // captcha in the window that appears; no terminal, no app restart.
        await this.interactiveLogin();
      } else {
        // Opt-out path: try the headless form login (works only on captcha-free
        // sites; otherwise it throws a clear message).
        await this.login(true);
      }
    })();
    this.reauthInFlight = p;

    try {
      await p;
    } finally {
      // Don't clobber a newer login that may have replaced ours.
      if (this.reauthInFlight === p) this.reauthInFlight = null;
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
    this.verifiedAccount = false;
    let headed;
    try {
      requireChromium();
      headed = await chromium.launch(chromiumLaunchOptions({ headless: false }));
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
        const current = await this.accountOf(context.request);
        if (current && !this.isConfiguredAccount(current)) {
          logger.warn("Saved session is for another account; signing in fresh", {
            sessionAccount: current,
            configuredAccount: this.cfg.email,
          });
          await context.clearCookies();
        } else {
          logger.info("Session already valid — no manual login needed");
          await this.persistFromContext(context);
          await headed.close();
          await this.browser.reloadSession();
          this.verifiedAccount = current !== null;
          return { success: true, finalUrl: page.url(), alreadyValid: true };
        }
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
      let submitted = false;
      while (Date.now() < deadline) {
        if (!this.isOnLoginPage(page.url())) {
          loggedIn = true;
          break;
        }
        // Once the user ticks the captcha, press Login for them. Resets after a
        // reload (e.g. wrong password) so a freshly solved captcha submits again.
        const ready = await this.captchaSolvedWithCredentials(page);
        if (!ready) submitted = false;
        else if (!submitted) {
          submitted = true;
          await page.click('button[type="submit"]', { timeout: 3000 }).catch(() => undefined);
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
      const signedInAs = await this.accountOf(context.request);
      if (signedInAs && !this.isConfiguredAccount(signedInAs)) {
        await headed.close();
        throw new Error(
          `You signed in as ${signedInAs}, but this MCP is set up for ${this.cfg.email} ` +
            `(LINKIT_EMAIL). Nothing was saved, so no ticket will be filed under the wrong ` +
            `name. Sign in with ${this.cfg.email}, or change LINKIT_EMAIL/LINKIT_PASSWORD ` +
            `in the MCP config to the account you want to use.`,
        );
      }
      await this.persistFromContext(context);
      await headed.close();
      await this.browser.reloadSession();
      this.verifiedAccount = signedInAs !== null;
      logger.info("Interactive login complete; session saved & reloaded", { finalUrl, signedInAs });
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
    await this.browser.writeSessionState(await context.storageState());
  }

  private async captchaSolvedWithCredentials(page: Page): Promise<boolean> {
    return page
      .evaluate(() => {
        const val = (sel: string) =>
          (document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null)?.value;
        return !!(
          val('textarea[name="g-recaptcha-response"]') &&
          val('input[name="email"]') &&
          val('input[name="password"]')
        );
      })
      .catch(() => false);
  }

  /**
   * The site slides the session expiry forward (48h) on every response, but
   * only in the cookie it sends back. Writing it to disk is what lets a
   * restarted/reconnected server reuse the session instead of a new captcha.
   */
  private async persistRefreshedSession(): Promise<void> {
    await this.browser.saveSession().catch((e) =>
      logger.warn("Could not persist refreshed session", e instanceof Error ? e.message : e),
    );
  }

  /** Keeps the session alive while the server runs, even if no tool is called. */
  startKeepAlive(intervalMs = 4 * 60 * 60 * 1000, firstDelayMs = 20000): void {
    const tick = async () => {
      if (this.reauthInFlight || !(await this.sessionFileValid())) return;
      try {
        const ok = await this.browser.touchSession(this.cfg.baseUrl, (u) => !this.isOnLoginPage(u));
        logger.info("Session keep-alive", { stillLoggedIn: ok });
      } catch (e) {
        logger.warn("Session keep-alive failed", e instanceof Error ? e.message : e);
      }
    };
    setTimeout(() => void tick(), firstDelayMs).unref();
    setInterval(() => void tick(), intervalMs).unref();
  }
}
