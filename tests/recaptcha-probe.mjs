import { chromium } from "playwright";
const BASE = process.env.LINKIT_BASE_URL || "https://report.linkit360.com";
const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const p = await b.newPage();
await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });
const info = await p.evaluate(() => {
  const scripts = Array.from(document.querySelectorAll("script[src]"))
    .map((s) => s.src)
    .filter((s) => /recaptcha|gstatic|hcaptcha|turnstile/i.test(s));
  const v2 = !!document.querySelector(".g-recaptcha, [data-sitekey]");
  const sitekey = document.querySelector("[data-sitekey]")?.getAttribute("data-sitekey") || null;
  const inlineScripts = Array.from(document.querySelectorAll("script:not([src])"))
    .map((s) => s.textContent || "")
    .filter((t) => /grecaptcha|recaptcha|execute\(/i.test(t))
    .map((t) => t.slice(0, 200));
  const iframes = Array.from(document.querySelectorAll("iframe"))
    .map((f) => f.src)
    .filter((s) => /recaptcha|hcaptcha|turnstile/i.test(s));
  return {
    scripts,
    v2_checkbox_present: v2,
    sitekey,
    inlineHints: inlineScripts,
    captchaIframes: iframes,
    bodyMentionsRecaptcha: /recaptcha/i.test(document.body.innerHTML),
  };
});
console.log(JSON.stringify(info, null, 2));
await b.close();
