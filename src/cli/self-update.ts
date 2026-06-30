#!/usr/bin/env node
/**
 * Self-updater — keeps every user on the latest code with ZERO manual steps.
 *
 * It pulls the newest commit from GitHub and rebuilds, entirely in the
 * background. It is intentionally conservative and silent:
 *   - a no-op unless this is a git checkout that is BEHIND its upstream and has
 *     a CLEAN working tree (never clobbers local edits or a .mcpb install),
 *   - throttled to at most once every few hours,
 *   - logs only to ~/.linkit360/auto-update.log, never to stdout (stdout is the
 *     MCP protocol stream for the parent server).
 *
 * The freshly built code takes effect the NEXT time the MCP server starts —
 * i.e. the next time the user opens the app — so they are never told to run a
 * command or to quit and reopen anything.
 *
 * It can also be run by hand:  node dist/cli/self-update.js  (or the
 * `ticketing-infra-360-update` bin), which is what update.command/.bat call.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  statSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const LOG_PATH = join(homedir(), ".linkit360", "auto-update.log");
// Stamp lives OUTSIDE the repo so it never shows up in `git status` (which
// would make us treat the tree as dirty and skip every future update).
const STAMP_PATH = join(homedir(), ".linkit360", "last-update-check");
const THROTTLE_MS = 6 * 60 * 60 * 1000; // 6 hours

function log(msg: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* logging must never throw */
  }
}

/** True only for OUR checkout — guards against updating an unrelated parent repo. */
function isOurRepo(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg?.name === "ticketing-infra-360-mcp";
  } catch {
    return false;
  }
}

/**
 * Walk up from this compiled file (dist/cli) to the repo root — the directory
 * that has BOTH a .git AND our own package.json. Requiring the identity match
 * means that if someone nests this project inside another git repo we never run
 * git fetch/merge + npm build against that unrelated repository.
 */
function findRepoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, ".git")) && isOurRepo(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function npm(root: string, args: string[]): void {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "npm.cmd" : "npm";
  execFileSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Node's CVE-2024-27980 fix throws EINVAL when spawning a .cmd/.bat without
    // a shell, so npm.cmd needs shell:true on Windows. Our args are static (no
    // user input), so this is safe.
    shell: isWin,
    // Under an Electron host, process.execPath is the Electron binary; this
    // makes any node invocations npm spawns behave as plain node.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

/**
 * Best-effort cross-process lock so two server instances starting together
 * don't run git pull + npm build concurrently in the same checkout. Returns the
 * fd to release later, or null if another updater holds a fresh lock.
 */
function acquireLock(): number | null {
  const p = join(homedir(), ".linkit360", "self-update.lock");
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    return openSync(p, "wx"); // exclusive create — fails if it already exists
  } catch {
    // Steal a stale lock (a previous run that died mid-update) after 15 minutes.
    try {
      if (Date.now() - statSync(p).mtimeMs > 15 * 60 * 1000) {
        rmSync(p, { force: true });
        return openSync(p, "wx");
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

function releaseLock(fd: number): void {
  const p = join(homedir(), ".linkit360", "self-update.lock");
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

function throttled(): boolean {
  try {
    if (existsSync(STAMP_PATH) && Date.now() - statSync(STAMP_PATH).mtimeMs < THROTTLE_MS) {
      return true;
    }
  } catch {
    /* ignore */
  }
  try {
    mkdirSync(dirname(STAMP_PATH), { recursive: true });
    writeFileSync(STAMP_PATH, String(Date.now()));
  } catch {
    /* ignore */
  }
  return false;
}

function run(): void {
  const force = process.argv.includes("--force");
  const root = findRepoRoot();
  if (!root) {
    log("Not a git checkout (e.g. a .mcpb install) — auto-update skipped.");
    return;
  }
  if (!force && throttled()) {
    log("Update checked recently — skipping this run.");
    return;
  }

  const lockFd = acquireLock();
  if (lockFd === null) {
    log("Another updater is already running — skipping this run.");
    return;
  }
  try {
    doUpdate(root);
  } finally {
    releaseLock(lockFd);
  }
}

/** The actual fetch → fast-forward → (install) → build, run while holding the lock. */
function doUpdate(root: string): void {
  // git must be present and the tree must be clean (don't clobber local work).
  let status: string;
  try {
    status = git(root, ["status", "--porcelain"]);
  } catch (e) {
    log(`git not available — auto-update skipped: ${(e as Error).message}`);
    return;
  }
  if (status) {
    log("Working tree has local changes — auto-update skipped to protect them.");
    return;
  }

  let branch = "main";
  try {
    branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
  } catch {
    /* keep default */
  }

  try {
    git(root, ["fetch", "--quiet", "origin", branch]);
  } catch (e) {
    log(`fetch failed (offline?) — skipped: ${(e as Error).message}`);
    return;
  }

  let local = "";
  let remote = "";
  try {
    local = git(root, ["rev-parse", "HEAD"]);
    remote = git(root, ["rev-parse", `origin/${branch}`]);
  } catch (e) {
    log(`rev-parse failed — skipped: ${(e as Error).message}`);
    return;
  }
  if (local === remote) {
    log(`Already up to date (${local.slice(0, 8)}).`);
    return;
  }

  log(`Update available: ${local.slice(0, 8)} -> ${remote.slice(0, 8)}. Pulling…`);
  try {
    git(root, ["merge", "--ff-only", `origin/${branch}`]);
  } catch (e) {
    log(`fast-forward not possible (branch diverged) — skipped: ${(e as Error).message}`);
    return;
  }

  // Reinstall deps only if package/lockfile changed (keeps the common case fast).
  try {
    const changed = git(root, ["diff", "--name-only", local, remote]);
    if (/(^|\/)package(-lock)?\.json/m.test(changed)) {
      log("Dependencies changed — running npm install…");
      npm(root, ["install", "--no-audit", "--no-fund"]);
    }
  } catch (e) {
    log(`dependency install issue (continuing to build): ${(e as Error).message}`);
  }

  try {
    log("Building…");
    npm(root, ["run", "build"]);
  } catch (e) {
    log(`build failed — leaving previous build in place: ${(e as Error).message}`);
    return;
  }

  try {
    writeFileSync(
      join(homedir(), ".linkit360", "last-update.json"),
      JSON.stringify({ from: local, to: remote, at: new Date().toISOString() }, null, 2),
    );
  } catch {
    /* ignore */
  }
  log(`Updated to ${remote.slice(0, 8)}. It applies automatically on the next launch.`);
}

try {
  run();
} catch (e) {
  log(`self-update crashed: ${(e as Error)?.stack || e}`);
}
