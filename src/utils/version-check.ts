import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../logger.js";

const PACKAGE = "ticketing-infra-360-mcp";
const LATEST_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;
/** Maintainer-controlled: raise `minVersion` here to stop older installs from writing to the site. */
const POLICY_URL =
  "https://raw.githubusercontent.com/bimopraksw/ticketing-infra-360-mcp/main/version-policy.json";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const RENOTIFY_MS = 24 * 60 * 60 * 1000;

/** Tools that change data on the site; refused while this version is below the minimum. */
export const WRITE_TOOLS = new Set(["create_infra_ticket", "reply_to_ticket", "close_ticket", "submit_form"]);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** null when package.json can't be read; then we never notify or block. */
export const CURRENT_VERSION: string | null = (() => {
  try {
    return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
})();

export type InstallType = "npx" | "git" | "global" | "mcpb" | "unknown";

function detectInstallType(): InstallType {
  if (existsSync(join(packageRoot, ".git"))) return "git";
  const p = packageRoot.split(sep).join("/");
  if (p.includes("/_npx/")) return "npx";
  if (/claude extensions/i.test(p)) return "mcpb";
  if (p.includes("/node_modules/")) return "global";
  return "unknown";
}

function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const body = await r.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface VersionStatus {
  current: string | null;
  latest: string | null;
  minVersion: string | null;
  updateAvailable: boolean;
  belowMinimum: boolean;
  policyMessage: string | null;
  installType: InstallType;
  checkedAt: string | null;
}

/**
 * Compares this install against the newest version on npm and the minimum
 * version in version-policy.json on GitHub. Network failures fail open: the
 * user is never blocked because a check couldn't run.
 */
export class VersionChecker {
  private status: VersionStatus = {
    current: CURRENT_VERSION,
    latest: null,
    minVersion: null,
    updateAvailable: false,
    belowMinimum: false,
    policyMessage: null,
    installType: detectInstallType(),
    checkedAt: null,
  };
  private firstCheck: Promise<void> | null = null;
  private lastNotice: { version: string; at: number } | null = null;

  start(): void {
    this.firstCheck = this.check();
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }

  async check(): Promise<void> {
    const [latestBody, policy] = await Promise.all([fetchJson(LATEST_URL), fetchJson(POLICY_URL)]);
    const s = this.status;
    if (typeof latestBody?.version === "string") s.latest = latestBody.version;
    if (policy) {
      s.minVersion = typeof policy.minVersion === "string" ? policy.minVersion : null;
      s.policyMessage = typeof policy.message === "string" && policy.message ? policy.message : null;
    }
    s.updateAvailable = !!(s.current && s.latest && compareVersions(s.latest, s.current) > 0);
    s.belowMinimum = !!(s.current && s.minVersion && compareVersions(s.current, s.minVersion) < 0);
    s.checkedAt = new Date().toISOString();
    logger.info("Version check", {
      current: s.current,
      latest: s.latest,
      minVersion: s.minVersion,
      installType: s.installType,
    });
  }

  getStatus(): VersionStatus {
    return { ...this.status };
  }

  howToUpdate(): string {
    switch (this.status.installType) {
      case "npx":
        return "Restart Claude to load it: quit Claude Desktop completely and reopen it (in Claude Code: /mcp, then Reconnect). Nothing else to do.";
      case "git":
        return "It downloads by itself in the background. Restart Claude to load it (quit Claude Desktop completely and reopen it; in Claude Code: /mcp, then Reconnect).";
      case "mcpb":
        return "This Claude Desktop extension (.mcpb) can't update itself. Remove it and add the npx config from INSTALL.md once; after that every update arrives with a restart.";
      case "global":
        return 'Switch the MCP config to npx ("command": "npx", "args": ["-y", "ticketing-infra-360-mcp"], see INSTALL.md) so updates arrive by themselves, then restart Claude.';
      default:
        return "Update ticketing-infra-360-mcp to the latest version (the npx config in INSTALL.md updates by itself), then restart Claude.";
    }
  }

  /** Refuses write tools while below the minimum. Waits briefly for the startup check. */
  async gate(tool: string): Promise<void> {
    if (!WRITE_TOOLS.has(tool)) return;
    if (this.firstCheck) {
      await Promise.race([this.firstCheck, new Promise((r) => setTimeout(r, 3000).unref())]);
    }
    const s = this.status;
    if (!s.belowMinimum) return;
    throw new Error(
      `Blocked: this ticketing MCP is v${s.current}, but the maintainers require at least ` +
        `v${s.minVersion} for creating, replying to or closing tickets. ` +
        (s.policyMessage ? `${s.policyMessage} ` : "") +
        `${this.howToUpdate()} Reading tickets still works.`,
    );
  }

  /** A note for the user about a newer version, at most once a day per version. */
  takeNotice(): string | null {
    const s = this.status;
    if (!s.updateAvailable || !s.latest) return null;
    const now = Date.now();
    if (this.lastNotice?.version === s.latest && now - this.lastNotice.at < RENOTIFY_MS) return null;
    this.lastNotice = { version: s.latest, at: now };
    return (
      `UPDATE AVAILABLE: ticketing-infra-360-mcp v${s.latest} is out (this install is v${s.current}). ` +
      `Please tell the user: ${this.howToUpdate()}`
    );
  }
}

type ToolResult = { content?: Array<{ type: string; text?: string }> };
type ToolHandler = (...args: unknown[]) => Promise<ToolResult>;

/** Wraps every tool registered after this call with the version gate and update notice. */
export function applyVersionGate(server: McpServer, checker: VersionChecker): void {
  const target = server as unknown as { registerTool: (...args: unknown[]) => unknown };
  const original = target.registerTool.bind(server);
  target.registerTool = (name: unknown, config: unknown, handler: unknown) =>
    original(name, config, async (...args: unknown[]) => {
      await checker.gate(String(name));
      const result = await (handler as ToolHandler)(...args);
      const notice = checker.takeNotice();
      if (notice && Array.isArray(result?.content)) result.content.push({ type: "text", text: notice });
      return result;
    });
}
