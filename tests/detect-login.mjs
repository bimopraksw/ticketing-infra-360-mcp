/**
 * Live login-form detection test — NO credentials required.
 * Launches Chromium, opens the real login page, and reports which selectors
 * the auth auto-detection would pick. Verifies the form-discovery logic works
 * against the actual LinkIT360 markup. Run: node tests/detect-login.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.LINKIT_BASE_URL || "https://report.linkit360.com";
const LOGIN = `${BASE}${process.env.LINKIT_LOGIN_PATH || "/login"}`;

const EMAIL = ['input[name="email"]', 'input[type="email"]', 'input[name="username"]', "#email"];
const PASS = ['input[name="password"]', 'input[type="password"]', "#password"];
const SUBMIT = ['button[type="submit"]', 'input[type="submit"]'];

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const resp = await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("URL:", page.url(), "status:", resp?.status());
  console.log("Title:", await page.title());

  const firstMatch = async (cands) => {
    for (const s of cands) if ((await page.locator(s).count()) > 0) return s;
    return null;
  };
  const email = await firstMatch(EMAIL);
  const pass = await firstMatch(PASS);
  const submit = await firstMatch(SUBMIT);

  console.log("Detected email selector   :", email);
  console.log("Detected password selector:", pass);
  console.log("Detected submit selector  :", submit);

  // Dump the login form's hidden inputs (CSRF token presence) for confirmation.
  const meta = await page.evaluate(() => {
    const form = document.querySelector("form");
    return {
      action: form?.getAttribute("action") || null,
      method: form?.getAttribute("method") || null,
      hasCsrf: !!document.querySelector('input[name="_token"], meta[name="csrf-token"]'),
    };
  });
  console.log("Login form:", JSON.stringify(meta));

  if (email && pass && submit) {
    console.log("\nLOGIN DETECTION PASSED ✅ — all three fields located.");
    process.exit(0);
  } else {
    console.error("\nLOGIN DETECTION INCOMPLETE ⚠️ — set LINKIT_LOGIN_*_SELECTOR overrides.");
    process.exit(2);
  }
} finally {
  await browser.close();
}
