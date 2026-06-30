import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

/**
 * Default location for the persisted login session: an absolute path in the
 * user's home directory. Using an absolute path (rather than a cwd-relative
 * one) means the file resolves to the same writable spot no matter which
 * working directory the MCP client launches the server from — so users never
 * need to set LINKIT_SESSION_PATH by hand.
 */
const DEFAULT_SESSION_PATH = join(homedir(), ".linkit360", "session.json");

/**
 * A boolean env var: any value other than a case-insensitive "false"/"0"/"no"
 * is treated as true. Used for the seamlessness switches that default ON.
 */
function boolFromEnv(defaultValue: "true" | "false") {
  return z
    .string()
    .default(defaultValue)
    .transform((v) => !["false", "0", "no", "off"].includes(v.trim().toLowerCase()));
}

/**
 * Parses and validates all environment configuration once at startup.
 * Throws a readable error if required values are missing.
 */
const EnvSchema = z.object({
  LINKIT_BASE_URL: z
    .string()
    .url("LINKIT_BASE_URL must be a valid URL")
    .transform((v) => v.replace(/\/+$/, "")),
  LINKIT_EMAIL: z.string().min(1, "LINKIT_EMAIL is required"),
  LINKIT_PASSWORD: z.string().min(1, "LINKIT_PASSWORD is required"),

  LINKIT_LOGIN_PATH: z.string().default("/login"),
  LINKIT_LOGIN_EMAIL_SELECTOR: z.string().optional(),
  LINKIT_LOGIN_PASSWORD_SELECTOR: z.string().optional(),
  LINKIT_LOGIN_SUBMIT_SELECTOR: z.string().optional(),
  LINKIT_LOGIN_SUCCESS_URL: z.string().optional(),

  LINKIT_HEADLESS: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  LINKIT_SESSION_PATH: z.string().default(DEFAULT_SESSION_PATH),
  LINKIT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  LINKIT_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  LINKIT_LOCALE: z.string().default("en-US"),

  // Seamlessness switches (all default ON). They make the server self-heal so
  // the user never has to open a terminal or restart the host app.
  //  - AUTO_LOGIN: when the session expires mid-task, transparently open a real
  //    browser window to re-login instead of erroring out.
  //  - AUTO_INSTALL_BROWSER: if Chromium is missing, install it in a detached
  //    background process (never inside the host, never blocking) and ask the
  //    caller to retry shortly.
  //  - AUTO_UPDATE: on startup, pull the newest code from GitHub in the
  //    background so updates reach every user with no manual steps.
  LINKIT_AUTO_LOGIN: boolFromEnv("true"),
  LINKIT_AUTO_INSTALL_BROWSER: boolFromEnv("true"),
  LINKIT_AUTO_UPDATE: boolFromEnv("true"),

  // Default ticket priority. P3 is the safe, no-approval-needed default; only
  // P0/P1/P2 trigger the approval workflow.
  LINKIT_DEFAULT_CLASSIFICATION: z
    .enum(["P0", "P1", "P2", "P3", "P4"])
    .default("P3"),

  LINKIT_LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppConfig {
  baseUrl: string;
  email: string;
  password: string;
  login: {
    path: string;
    emailSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
    successUrl?: string;
  };
  headless: boolean;
  sessionPath: string;
  timeoutMs: number;
  maxRetries: number;
  locale: string;
  autoLogin: boolean;
  autoInstallBrowser: boolean;
  autoUpdate: boolean;
  defaultClassification: "P0" | "P1" | "P2" | "P3" | "P4";
  logLevel: "debug" | "info" | "warn" | "error";
}

function emptyToUndefined(v?: string): string | undefined {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the required values.`,
    );
  }
  const e = parsed.data;
  return {
    baseUrl: e.LINKIT_BASE_URL,
    email: e.LINKIT_EMAIL,
    password: e.LINKIT_PASSWORD,
    login: {
      path: e.LINKIT_LOGIN_PATH,
      emailSelector: emptyToUndefined(e.LINKIT_LOGIN_EMAIL_SELECTOR),
      passwordSelector: emptyToUndefined(e.LINKIT_LOGIN_PASSWORD_SELECTOR),
      submitSelector: emptyToUndefined(e.LINKIT_LOGIN_SUBMIT_SELECTOR),
      successUrl: emptyToUndefined(e.LINKIT_LOGIN_SUCCESS_URL),
    },
    headless: e.LINKIT_HEADLESS,
    sessionPath: emptyToUndefined(e.LINKIT_SESSION_PATH) ?? DEFAULT_SESSION_PATH,
    timeoutMs: e.LINKIT_TIMEOUT_MS,
    maxRetries: e.LINKIT_MAX_RETRIES,
    locale: e.LINKIT_LOCALE,
    autoLogin: e.LINKIT_AUTO_LOGIN,
    autoInstallBrowser: e.LINKIT_AUTO_INSTALL_BROWSER,
    autoUpdate: e.LINKIT_AUTO_UPDATE,
    defaultClassification: e.LINKIT_DEFAULT_CLASSIFICATION,
    logLevel: e.LINKIT_LOG_LEVEL,
  };
}

/** Resolves a path (relative or absolute) against the configured base URL. */
export function resolveUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${baseUrl}${path}`;
}
