import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger.js";

/*
 * Ways to get past the login reCAPTCHA without a person ticking it:
 *
 *  - 2Captcha (https://2captcha.com, needs TWOCAPTCHA_KEY): its workers solve
 *    the captcha in their own browsers and we get a token for the form. This
 *    is the one that passes the LinkIT360 captcha: Google lets these workers
 *    through on our portal's key, but not NopeCHA's robot solvers.
 *  - NopeCHA Token API (https://nopecha.com, needs NOPECHA_KEY): same idea
 *    with NopeCHA's own solvers. Works on lenient sites, never finished on
 *    the LinkIT360 portal in tests (2026-11).
 *  - NopeCHA browser extension (LINKIT_CAPTCHA_SOLVER=nopecha-extension): the
 *    extension clicks through the image challenge in a hidden browser. Google
 *    keeps adding rounds for automated browsers, so it is opt-in only.
 *
 * The token services only get the sitekey and page URL; the password never
 * leaves this machine.
 */

/**
 * NopeCHA browser extension (https://github.com/NopeCHALLC/nopecha-extension),
 * "automation" build for Chromium. Pinned and hash checked: the extension is
 * closed source and gets broad permissions inside the login browser, so a new
 * build is only used after someone updates these three values on purpose.
 */
export const NOPECHA_VERSION = "0.6.1";
const NOPECHA_URL = `https://github.com/NopeCHALLC/nopecha-extension/releases/download/${NOPECHA_VERSION}/chromium_automation.zip`;
const NOPECHA_SHA256 = "92ebe154bd34433b4a36e6b2df33006fa6acb19a1b81031a0acb5b72be5e025a";

const EXTENSIONS_DIR = join(homedir(), ".linkit360", "extensions");

let preparing: Promise<string> | null = null;

/** Unpacks a zip with the system tools (bsdtar on macOS/Windows, unzip on Linux). */
function extractZip(zipPath: string, dest: string): void {
  const attempts: Array<[string, string[]]> = [
    ["tar", ["-xf", zipPath, "-C", dest]],
    ["unzip", ["-q", "-o", zipPath, "-d", dest]],
  ];
  const errors: string[] = [];
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: "ignore", timeout: 60000 });
      if (existsSync(join(dest, "manifest.json"))) return;
      errors.push(`${cmd}: no manifest.json after extract`);
    } catch (e) {
      errors.push(`${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`Could not unpack the NopeCHA extension (${errors.join("; ")})`);
}

async function download(): Promise<Buffer> {
  const resp = await fetch(NOPECHA_URL, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status} for ${NOPECHA_URL}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== NOPECHA_SHA256) {
    throw new Error(
      `NopeCHA ${NOPECHA_VERSION} download has an unexpected checksum (${sha}); refusing to load it.`,
    );
  }
  return buf;
}

/**
 * Writes our settings into the extension's manifest: solve reCAPTCHA on its
 * own, nothing else, and use the NopeCHA key when one is configured (without
 * a key NopeCHA allows about 100 solves a day per IP address).
 */
async function configure(dir: string, apiKey: string | undefined): Promise<void> {
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const settings = manifest.nopecha ?? {};
  for (const k of Object.keys(settings)) {
    if (/_auto_(open|solve)$/.test(k)) settings[k] = false;
  }
  Object.assign(settings, {
    enabled: true,
    key: apiKey ?? "",
    recaptcha_auto_open: true,
    recaptcha_auto_solve: true,
    mouse_visualization: false,
  });
  manifest.nopecha = settings;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Returns the folder of the unpacked, configured NopeCHA extension,
 * downloading it the first time (about 650 KB).
 */
export function prepareNopechaExtension(apiKey: string | undefined): Promise<string> {
  if (!preparing) {
    preparing = (async () => {
      const dir = join(EXTENSIONS_DIR, `nopecha-${NOPECHA_VERSION}`);
      if (!existsSync(join(dir, "manifest.json"))) {
        logger.info("Downloading the NopeCHA captcha solver", { version: NOPECHA_VERSION });
        await mkdir(EXTENSIONS_DIR, { recursive: true });
        const work = await mkdtemp(join(EXTENSIONS_DIR, ".nopecha-"));
        try {
          const zipPath = join(work, "nopecha.zip");
          await writeFile(zipPath, await download());
          const unpacked = join(work, "unpacked");
          await mkdir(unpacked);
          extractZip(zipPath, unpacked);
          await rm(dir, { recursive: true, force: true });
          await rename(unpacked, dir);
        } finally {
          await rm(work, { recursive: true, force: true });
        }
      }
      await configure(dir, apiKey);
      return dir;
    })().catch((e) => {
      preparing = null;
      throw e;
    });
  }
  return preparing;
}

const TOKEN_API = "https://api.nopecha.com/v1/token/recaptcha2";

/** A readable reason for a NopeCHA API error, with what to do about it. */
function nopechaError(status: number, body: { error?: number; message?: string }): string {
  const base = `NopeCHA: ${body?.message ?? `HTTP ${status}`}`;
  switch (body?.error) {
    case 15:
      return `${base}. Check NOPECHA_KEY in the MCP config.`;
    case 16:
      return `${base}. Today's credits are used up; they refill every 23 hours.`;
    case 18:
      return `${base}. This NopeCHA plan doesn't include token solving.`;
    case 12:
      return `${base}. Free credits don't work from VPN or proxy IP addresses.`;
    default:
      // NopeCHA answers a wrong key with a bare Cloudflare 520, not a 401.
      return status >= 500 ? `${base} (NopeCHA server error; also check that NOPECHA_KEY is right)` : base;
  }
}

async function callTokenApi(
  key: string,
  init: { method: "GET" | "POST"; query?: string; body?: unknown },
): Promise<{ status: number; body: { data?: unknown; error?: number; message?: string } }> {
  const resp = await fetch(`${TOKEN_API}${init.query ?? ""}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30000),
  });
  const body = (await resp.json().catch(() => ({}))) as { data?: unknown; error?: number; message?: string };
  return { status: resp.status, body };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Asks the NopeCHA Token API to solve a reCAPTCHA v2 and returns the
 * g-recaptcha-response token. Only the sitekey and page URL are sent; the
 * credentials never leave this machine.
 */
export async function solveRecaptchaToken(opts: {
  key: string;
  sitekey: string;
  url: string;
  dataS?: string;
  timeoutMs: number;
}): Promise<string> {
  const payload = {
    sitekey: opts.sitekey,
    url: opts.url,
    ...(opts.dataS ? { data: { s: opts.dataS } } : {}),
  };
  let submit = await callTokenApi(opts.key, { method: "POST", body: payload });
  if (submit.status === 429) {
    await sleep(5000);
    submit = await callTokenApi(opts.key, { method: "POST", body: payload });
  }
  if (submit.status !== 200 || typeof submit.body.data !== "string") {
    throw new Error(nopechaError(submit.status, submit.body));
  }
  const id = submit.body.data;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    const poll = await callTokenApi(opts.key, { method: "GET", query: `?id=${encodeURIComponent(id)}` });
    if (poll.status === 200 && typeof poll.body.data === "string") return poll.body.data;
    if (poll.status === 409 || poll.body.error === 14) continue;
    if (poll.status === 429 || poll.body.error === 11) {
      await sleep(3000);
      continue;
    }
    throw new Error(nopechaError(poll.status, poll.body));
  }
  throw new Error(`NopeCHA did not return a token within ${Math.round(opts.timeoutMs / 1000)}s`);
}

const TWOCAPTCHA_API = "https://api.2captcha.com";

interface TwoCaptchaReply {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
  status?: string;
  solution?: { gRecaptchaResponse?: string };
}

/** A readable reason for a 2Captcha error, with what to do about it. */
function twoCaptchaError(reply: TwoCaptchaReply, key: string): string {
  // Some 2Captcha messages repeat the key; never pass it on.
  const text = (reply.errorDescription || reply.errorCode || "unknown error")
    .split(key)
    .join("[key]")
    .trim()
    .replace(/\.$/, "");
  const base = `2Captcha: ${text}`;
  switch (reply.errorCode) {
    case "ERROR_KEY_DOES_NOT_EXIST":
    case "ERROR_WRONG_USER_KEY":
      return `${base}. Check TWOCAPTCHA_KEY in the MCP config.`;
    case "ERROR_ZERO_BALANCE":
      return `${base}. The 2Captcha balance is empty; top it up at https://2captcha.com.`;
    case "ERROR_IP_NOT_ALLOWED":
    case "IP_BANNED":
      return `${base}. This IP address is not allowed by the 2Captcha account.`;
    default:
      return base;
  }
}

async function call2Captcha(method: "createTask" | "getTaskResult", body: object): Promise<TwoCaptchaReply> {
  const resp = await fetch(`${TWOCAPTCHA_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return (await resp.json().catch(() => ({ errorId: 1, errorCode: `HTTP ${resp.status}` }))) as TwoCaptchaReply;
}

/**
 * Asks 2Captcha to solve a reCAPTCHA v2 and returns the g-recaptcha-response
 * token. A solve usually takes 20 to 60 seconds and costs about $0.003. When
 * a worker gives up (unsolvable) we ask once more with a new task.
 */
export async function solveRecaptchaWith2Captcha(opts: {
  key: string;
  sitekey: string;
  url: string;
  dataS?: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  const task = {
    type: "RecaptchaV2TaskProxyless",
    websiteURL: opts.url,
    websiteKey: opts.sitekey,
    ...(opts.dataS ? { recaptchaDataSValue: opts.dataS } : {}),
  };
  let attempts = 0;
  while (Date.now() < deadline && attempts < 2) {
    const created = await call2Captcha("createTask", { clientKey: opts.key, task });
    if (created.errorCode === "ERROR_NO_SLOT_AVAILABLE") {
      await sleep(5000);
      continue;
    }
    if (created.errorId || typeof created.taskId !== "number") {
      throw new Error(twoCaptchaError(created, opts.key));
    }
    attempts++;
    await sleep(10000);
    while (Date.now() < deadline) {
      let result: TwoCaptchaReply;
      try {
        result = await call2Captcha("getTaskResult", { clientKey: opts.key, taskId: created.taskId });
      } catch (e) {
        // A dropped poll is not a failed solve; ask again.
        logger.debug("2Captcha poll failed; retrying", { error: e instanceof Error ? e.message : String(e) });
        await sleep(5000);
        continue;
      }
      const token = result.solution?.gRecaptchaResponse;
      if (result.status === "ready" && token) return token;
      if (result.errorCode === "ERROR_CAPTCHA_UNSOLVABLE") break;
      if (result.errorId) throw new Error(twoCaptchaError(result, opts.key));
      await sleep(5000);
    }
  }
  throw new Error(
    attempts >= 2 && Date.now() < deadline
      ? "2Captcha could not solve the captcha (tried twice)"
      : `2Captcha did not return a token within ${Math.round(opts.timeoutMs / 1000)}s`,
  );
}

/** A throwaway browser profile for one solver login. */
export function tempProfileDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "linkit360-login-"));
}
