import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { WRITE_TOOLS } from "./version-check.js";

/** A readable name for this computer, e.g. "Bimo's MacBook Air". */
export const COMPUTER_NAME: string = (() => {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (name) return name;
    } catch {
      // fall back to the host name
    }
  }
  return hostname().replace(/\.local$/i, "");
})();

/**
 * Whether `requestedBy` (an email or a name) is the owner of `accountEmail`.
 * An email must match exactly. A name matches when one of its words (3+ letters)
 * appears in the account's email name, so "Bimo" or "Bimo Prakoso" match
 * bimo.prakoso@..., while "Syiffa Putri" does not.
 */
export function requesterMatches(requestedBy: string, accountEmail: string): boolean {
  const who = requestedBy.trim().toLowerCase();
  const account = accountEmail.trim().toLowerCase();
  if (!who || !account) return false;
  if (who.includes("@")) return who === account;
  const local = account.split("@")[0].replace(/[^a-z]/g, "");
  return who.split(/[^a-z]+/).some((word) => word.length >= 3 && local.includes(word));
}

const REQUESTED_BY_HELP =
  "Who is asking for this: their email (preferred) or full name, as they told you in THIS " +
  "conversation. Several people may share one Claude account, so do not take it from memory, " +
  "earlier chats or the account profile. If this conversation hasn't made clear who the user " +
  "is, ask them once before calling. The tool refuses when this person is not the owner of " +
  "the LinkIT360 account set up on the computer running this MCP.";

type ToolResult = { content?: Array<{ type: string; text?: string }> };
type ToolHandler = (args: Record<string, unknown>, ...rest: unknown[]) => Promise<ToolResult>;

/**
 * Makes every write tool registered after this call take a required
 * `requestedBy` and refuse when it isn't the owner of the configured account.
 * Successful calls get a note saying which account and computer acted.
 */
export function applyRequesterGuard(server: McpServer, cfg: AppConfig): void {
  if (!cfg.checkRequester) return;
  const target = server as unknown as { registerTool: (...args: unknown[]) => unknown };
  const original = target.registerTool.bind(server);
  target.registerTool = (name: unknown, config: unknown, handler: unknown) => {
    if (!WRITE_TOOLS.has(String(name))) return original(name, config, handler);
    const c = config as { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
    const guarded = {
      ...c,
      description:
        `${c.description ?? ""} Everything this tool does is filed under the LinkIT360 account ` +
        "set up on the computer running this MCP; pass `requestedBy` (who is asking you).",
      inputSchema: {
        ...(c.inputSchema ?? {}),
        requestedBy: z.string().min(1).describe(REQUESTED_BY_HELP),
      },
    };
    return original(name, guarded, async (args: Record<string, unknown>, ...rest: unknown[]) => {
      const { requestedBy, ...toolArgs } = args;
      const who = String(requestedBy ?? "").trim();
      if (!requesterMatches(who, cfg.email)) {
        throw new Error(
          `Refused: this ticketing MCP runs on the computer "${COMPUTER_NAME}" and is set up for ` +
            `the LinkIT360 account ${cfg.email}, but this request is from "${who}". Doing it here ` +
            `would file it under ${cfg.email}'s name. This usually means several people share one ` +
            `Claude account and the chat reached someone else's computer. Tell the user: open ` +
            `Claude Desktop on your own laptop, where this MCP is set up with your own LinkIT360 ` +
            `account, and ask there. Do not retry with ${cfg.email} as requestedBy unless the ` +
            `user confirms they are that person.`,
        );
      }
      const result = await (handler as ToolHandler)(toolArgs, ...rest);
      if (Array.isArray(result?.content)) {
        result.content.push({
          type: "text",
          text:
            `Acting as LinkIT360 account ${cfg.email} on the computer "${COMPUTER_NAME}" ` +
            `(requested by ${who}). Mention this account to the user.`,
        });
      }
      return result;
    });
  };
}
