/**
 * Authenticated site crawler / mapper.
 * Logs in with .env credentials, then BFS-crawls same-origin pages up to a
 * depth/page limit, recording for each page: title, status, links, and any
 * forms (with fields). Writes a full map to discovery/site-map.json and prints
 * a summary. Run:  node tests/crawl.mjs
 */
import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";

loadEnv();

const BASE = (process.env.LINKIT_BASE_URL || "https://report.linkit360.com").replace(/\/+$/, "");
const EMAIL = process.env.LINKIT_EMAIL;
const PASSWORD = process.env.LINKIT_PASSWORD;
const LOGIN = `${BASE}${process.env.LINKIT_LOGIN_PATH || "/login"}`;
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES || 60);
const MAX_DEPTH = Number(process.env.CRAWL_MAX_DEPTH || 3);
const TIMEOUT = Number(process.env.LINKIT_TIMEOUT_MS || 30000);

if (!EMAIL || !PASSWORD) {
  console.error("Missing LINKIT_EMAIL / LINKIT_PASSWORD in .env");
  process.exit(1);
}

const origin = new URL(BASE).origin;
const isLogin = (u) => {
  try { return new URL(u).pathname.toLowerCase().includes("login"); } catch { return false; }
};
// Paths we must NOT visit (would end the session).
const BLOCKED = [/logout/i, /sign-?out/i];
const norm = (u) => {
  try {
    const url = new URL(u, BASE);
    url.hash = "";
    return url.href;
  } catch { return null; }
};

const SESSION = process.env.LINKIT_SESSION_PATH || ".session/storage-state.json";
async function validSession() {
  if (!existsSync(SESSION)) return false;
  try {
    const p = JSON.parse(await readFile(SESSION, "utf8"));
    return Array.isArray(p?.cookies) && p.cookies.length > 0;
  } catch { return false; }
}
const hasSession = await validSession();

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  storageState: hasSession ? SESSION : undefined,
});
ctx.setDefaultTimeout(TIMEOUT);
ctx.setDefaultNavigationTimeout(TIMEOUT);
const page = await ctx.newPage();

async function login() {
  // The login page uses reCAPTCHA, so we rely on a session established via
  // `npm run login`. Here we only verify that session is still valid.
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (!isLogin(page.url())) {
    console.error("Session valid ->", page.url());
    return true;
  }
  throw new Error(
    "No valid session (login page is reCAPTCHA-protected). " +
      "Run `npm run login` first to establish a session, then re-run this crawler.",
  );
}

async function inspect(u) {
  const resp = await page.goto(u, { waitUntil: "domcontentloaded" }).catch((e) => { throw e; });
  await page.waitForLoadState("networkidle").catch(() => {});
  const finalUrl = page.url();
  if (isLogin(finalUrl) && !isLogin(u)) {
    return { url: u, finalUrl, status: resp?.status() ?? null, redirectedToLogin: true, links: [], forms: [] };
  }
  const data = await page.evaluate(() => {
    const sel = (el) => {
      const n = el.getAttribute("name");
      if (n) return `${el.tagName.toLowerCase()}[name="${n}"]`;
      if (el.id) return `#${el.id}`;
      return el.tagName.toLowerCase();
    };
    const label = (el) => {
      const id = el.getAttribute("id");
      if (id) { const l = document.querySelector(`label[for="${id}"]`); if (l?.textContent) return l.textContent.trim().replace(/\s+/g," "); }
      return el.getAttribute("aria-label") || el.getAttribute("placeholder") || null;
    };
    const links = Array.from(document.querySelectorAll("a[href]"))
      .map((a) => a.getAttribute("href")).filter(Boolean);
    const forms = Array.from(document.querySelectorAll("form")).map((f, i) => ({
      index: i, id: f.getAttribute("id") || null, action: f.getAttribute("action") || null,
      method: (f.getAttribute("method") || "get").toLowerCase(),
      fields: Array.from(f.querySelectorAll("input,select,textarea"))
        .filter((el) => (el.getAttribute("type") || "").toLowerCase() !== "hidden")
        .map((el) => ({
          name: el.getAttribute("name") || null, selector: sel(el),
          type: el.tagName.toLowerCase() === "select" ? "select" : (el.getAttribute("type") || el.tagName.toLowerCase()),
          label: label(el), required: el.hasAttribute("required"),
          options: el.tagName.toLowerCase() === "select"
            ? Array.from(el.options).map((o) => ({ value: o.value, label: o.textContent?.trim() })) : undefined,
        })),
    }));
    return { title: document.title, links, forms };
  });
  return { url: u, finalUrl, status: resp?.status() ?? null, title: data.title, links: data.links, forms: data.forms };
}

const seen = new Set();
const queue = [{ url: BASE, depth: 0 }];
const results = [];

try {
  await login();
  // seed with the post-login landing page
  queue.push({ url: page.url(), depth: 0 });

  while (queue.length && results.length < MAX_PAGES) {
    const { url, depth } = queue.shift();
    const key = norm(url);
    if (!key || seen.has(key)) continue;
    if (new URL(key).origin !== origin) continue;
    if (BLOCKED.some((re) => re.test(key))) continue;
    seen.add(key);

    try {
      const info = await inspect(key);
      results.push({ depth, ...info });
      const formCount = info.forms?.length || 0;
      console.error(`[${results.length}] d${depth} ${info.status} ${formCount}form ${key}`);
      if (depth < MAX_DEPTH && !info.redirectedToLogin) {
        for (const href of info.links || []) {
          const n = norm(href);
          if (n && !seen.has(n) && new URL(n).origin === origin && !BLOCKED.some((re) => re.test(n))) {
            queue.push({ url: n, depth: depth + 1 });
          }
        }
      }
    } catch (e) {
      results.push({ depth, url: key, error: String(e?.message || e) });
      console.error(`[ERR] ${key}: ${e?.message || e}`);
    }
  }

  await mkdir("discovery", { recursive: true });
  const pagesWithForms = results.filter((r) => (r.forms?.length || 0) > 0);
  const map = {
    base: BASE, crawledAt: new Date().toISOString(),
    pageCount: results.length, formPageCount: pagesWithForms.length, pages: results,
  };
  await writeFile("discovery/site-map.json", JSON.stringify(map, null, 2));

  // Unique navigable paths
  const paths = [...new Set(results.map((r) => { try { return new URL(r.finalUrl || r.url).pathname; } catch { return r.url; } }))].sort();
  console.error("\n==== SITE MAP SUMMARY ====");
  console.error(`Pages crawled: ${results.length}  |  Pages with forms: ${pagesWithForms.length}`);
  console.error("\nUnique paths:");
  for (const p of paths) console.error("  " + p);
  console.error("\nPages containing forms (candidate create/update targets):");
  for (const r of pagesWithForms) {
    const path = (() => { try { return new URL(r.finalUrl || r.url).pathname; } catch { return r.url; } })();
    console.error(`  ${path}  (${r.forms.length} form, fields: ${r.forms.flatMap((f) => f.fields.map((x) => x.name).filter(Boolean)).slice(0, 12).join(", ")})`);
  }
  console.error("\nFull map written to discovery/site-map.json");
} finally {
  await browser.close();
}
